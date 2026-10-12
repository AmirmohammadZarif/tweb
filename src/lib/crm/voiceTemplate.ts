// CRM voice response templates: pre-recorded audio replies the agent sends to the
// customer as a voice message. The bytes come from the CRM as a base64 data URI;
// this turns them into something appMessagesManager.sendFile can post as a voice
// note (duration + waveform) and something an <audio> element can preview.

import {CrmVoiceTemplateAudio} from '@lib/crm/types';
import rootScope from '@lib/rootScope';
import opusDecodeController from '@lib/opusDecodeController';
import VoiceWaveformAnalyser from '@helpers/voiceWaveformAnalyser';

// Telegram plays voice notes in OGG/Opus, MP3 and M4A; anything else (e.g. WAV)
// goes out as a plain audio file instead.
const VOICE_MIME_TYPES = new Set(['audio/ogg', 'audio/opus', 'video/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac']);

export type PreparedCrmVoiceTemplate = {
  file: File,
  isVoice: boolean,
  duration: number,
  waveform: Uint8Array,
  // playable URL — OGG is pre-decoded to WAV since Safari can't play Opus
  objectURL: string
};

// * picking a template right after previewing it shouldn't download it twice
const CACHE_SIZE = 5;
const cache: Map<number, Promise<PreparedCrmVoiceTemplate>> = new Map();

function isOgg(mime: string) {
  return mime === 'audio/ogg' || mime === 'audio/opus' || mime === 'video/ogg';
}

async function prepare(templateId: number): Promise<PreparedCrmVoiceTemplate> {
  const audio: CrmVoiceTemplateAudio = await rootScope.managers.appCrmManager.getVoiceTemplateAudio(templateId);
  if(!audio?.data) {
    throw new Error('no audio');
  }

  // * a data: URI fetch resolves locally — no network / CORS involved
  const blob = await fetch(audio.data).then((r) => r.blob());
  const mime = (audio.mime || blob.type || '').split(';')[0].toLowerCase();
  const bytes = new Uint8Array(await blob.arrayBuffer());

  let objectURL: string, decodable: ArrayBuffer;
  if(isOgg(mime)) {
    const {blob: wav} = await opusDecodeController.decode(bytes.slice(), false);
    opusDecodeController.setKeepAlive(false);
    objectURL = URL.createObjectURL(wav);
    decodable = await wav.arrayBuffer();
  } else {
    objectURL = URL.createObjectURL(blob);
    decodable = bytes.slice().buffer;
  }

  let duration = 0, waveform: Uint8Array;
  try {
    const audioBuffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(decodable);
    duration = Math.round(audioBuffer.duration);
    const analyser = new VoiceWaveformAnalyser();
    analyser.feed(audioBuffer.getChannelData(0));
    waveform = analyser.finish();
  } catch(err) {
    // * still sendable without a waveform; the bubble just renders it flat
  }

  return {
    file: new File([blob], audio.name || `voice-${templateId}`, {type: mime || 'audio/ogg'}),
    isVoice: VOICE_MIME_TYPES.has(mime),
    duration,
    waveform,
    objectURL
  };
}

export default function prepareCrmVoiceTemplate(templateId: number) {
  let promise = cache.get(templateId);
  if(!promise) {
    promise = prepare(templateId);
    promise.catch(() => cache.delete(templateId));
    cache.set(templateId, promise);
    if(cache.size > CACHE_SIZE) {
      cache.delete(cache.keys().next().value);
    }
  }

  return promise;
}
