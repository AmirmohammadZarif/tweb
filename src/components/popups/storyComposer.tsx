import {createSignal, onCleanup, onMount, untrack, useContext, For, Show} from 'solid-js';
import PopupElement, {createPopup, PopupContext} from '@components/popups/indexTsx';
import CheckboxFieldTsx from '@components/checkboxFieldTsx';
import InputField from '@components/inputField';
import {toastNew} from '@components/toast';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import requestFile from '@helpers/files/requestFile';
import preloadVideo from '@helpers/preloadVideo';
import detectVideoHasSound from '@helpers/video/detectVideoHasSound';
import getFileNameForUpload from '@helpers/getFileNameForUpload';
import {subscribeOn} from '@helpers/solid/subscribeOn';
import classNames from '@helpers/string/classNames';
import {i18n, LangPackKey} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import {SendStoryPrivacy} from '@appManagers/appStoriesManager';
import styles from './storyComposer.module.scss';

// Telegram rejects longer story videos server-side — fail here with a readable
// message instead of after a full upload.
const MAX_VIDEO_DURATION = 60;
const CAPTION_MAX_LENGTH = 2048;
const PERIODS = [6, 12, 24, 48];
const DEFAULT_PERIOD = 24;

const PRIVACIES: {value: SendStoryPrivacy, text: LangPackKey}[] = [
  {value: 'everyone', text: 'Stories.Composer.Privacy.Everyone'},
  {value: 'contacts', text: 'Stories.Composer.Privacy.Contacts'},
  {value: 'close', text: 'Stories.Composer.Privacy.CloseFriends'}
];

type StoryMedia = {
  file: File,
  url: string,
  isVideo: boolean,
  width: number,
  height: number,
  duration?: number,
  hasSound?: boolean
};

async function readMedia(file: File): Promise<StoryMedia> {
  const url = URL.createObjectURL(file);
  const isVideo = file.type.startsWith('video/');

  try {
    if(!isVideo) {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.addEventListener('load', () => resolve(image), {once: true});
        image.addEventListener('error', reject, {once: true});
        image.src = url;
      });

      return {file, url, isVideo, width: image.naturalWidth, height: image.naturalHeight};
    }

    const video = await preloadVideo(url);
    return {
      file,
      url,
      isVideo,
      width: video.videoWidth,
      height: video.videoHeight,
      duration: Math.floor(video.duration),
      hasSound: await detectVideoHasSound(video)
    };
  } catch(err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function StoryComposer(props: {peerId: PeerId, media: StoryMedia}) {
  const context = useContext(PopupContext);
  const managers = untrack(() => context.managers);
  const isChannel = props.peerId.isAnyChat();
  // The server only honours a custom expiration for Premium accounts — everyone
  // else gets the default 24h, so don't offer a choice that would just error.
  const canChoosePeriod = isChannel || rootScope.premium;

  const [privacy, setPrivacy] = createSignal<SendStoryPrivacy>('everyone');
  const [period, setPeriod] = createSignal(DEFAULT_PERIOD);
  const [pinned, setPinned] = createSignal(isChannel);
  const [posting, setPosting] = createSignal(false);
  const [progress, setProgress] = createSignal(0);

  const captionInputField = new InputField({
    placeholder: 'Stories.Composer.CaptionPlaceholder',
    maxLength: CAPTION_MAX_LENGTH,
    withLinebreaks: true
  });
  captionInputField.container.classList.add('input-field-textarea', styles.caption);

  // The upload runs in the worker, so its progress only reaches us through the
  // global event — keyed by the file name we hand to sendStory.
  const fileName = getFileNameForUpload(props.media.file);
  subscribeOn(rootScope)('download_progress', (details) => {
    if(details.fileName !== fileName || !details.total) return;
    setProgress(details.done / details.total);
  });

  let postBtn!: HTMLButtonElement;

  const onPost = async() => {
    if(posting()) return;
    setPosting(true);

    try {
      await managers.appStoriesManager.sendStory({
        peerId: props.peerId,
        file: props.media.file,
        fileName,
        isVideo: props.media.isVideo,
        mimeType: props.media.file.type,
        width: props.media.width,
        height: props.media.height,
        duration: props.media.duration,
        hasSound: props.media.hasSound,
        caption: captionInputField.value.trim(),
        privacy: isChannel ? 'everyone' : privacy(),
        period: canChoosePeriod ? period() * 3600 : undefined,
        pinned: pinned()
      });

      toastNew({langPackKey: 'Stories.Composer.Posted'});
      context.hide();
    } catch(err) {
      setPosting(false);
      setProgress(0);
      toastNew({langPackKey: 'Error.AnError'});
      console.error('story send error', err);
    }
  };

  onMount(() => {
    attachClickEvent(postBtn, onPost);
  });

  onCleanup(() => {
    URL.revokeObjectURL(props.media.url);
  });

  return (
    <>
      <PopupElement.Header>
        <PopupElement.CloseButton />
        <PopupElement.Title title="Stories.Composer.Title" />
      </PopupElement.Header>
      <PopupElement.Body class={styles.body}>
        <div class={styles.preview}>
          <Show
            when={props.media.isVideo}
            fallback={<img class={styles.media} src={props.media.url} />}
          >
            <video class={styles.media} src={props.media.url} autoplay loop muted playsinline />
          </Show>
        </div>

        {captionInputField.container}

        <Show when={!isChannel}>
          <div class={styles.sectionTitle}>{i18n('Stories.Composer.Privacy')}</div>
          <div class={styles.chips}>
            <For each={PRIVACIES}>{(option) => (
              <button
                class={classNames(styles.chip, privacy() === option.value && styles.chipActive)}
                onClick={() => setPrivacy(option.value)}
              >
                {i18n(option.text)}
              </button>
            )}</For>
          </div>
        </Show>

        <Show when={canChoosePeriod}>
          <div class={styles.sectionTitle}>{i18n('Stories.Composer.Period')}</div>
          <div class={styles.chips}>
            <For each={PERIODS}>{(hours) => (
              <button
                class={classNames(styles.chip, period() === hours && styles.chipActive)}
                onClick={() => setPeriod(hours)}
              >
                {i18n('Hours', [hours])}
              </button>
            )}</For>
          </div>
        </Show>

        <CheckboxFieldTsx
          class={styles.checkbox}
          text={isChannel ? 'Stories.Composer.KeepOnChannel' : 'Stories.Composer.KeepOnProfile'}
          toggle
          checked={pinned()}
          onChange={setPinned}
        />
      </PopupElement.Body>
      <PopupElement.Footer>
        <button
          ref={postBtn}
          class="popup-footer-button btn-primary btn-color-primary"
          disabled={posting()}
        >
          <Show when={posting()} fallback={i18n('Stories.Composer.Post')}>
            {i18n('Stories.Composer.Posting', [Math.round(progress() * 100)])}
          </Show>
        </button>
      </PopupElement.Footer>
    </>
  );
}

export function showStoryComposerPopup(options: {peerId: PeerId, media: StoryMedia}) {
  createPopup(() => (
    <PopupElement class={styles.popup} closable>
      <StoryComposer peerId={options.peerId} media={options.media} />
    </PopupElement>
  ));
}

/**
 * Asks for a photo/video, validates it, then opens the composer for `peerId`.
 * Callers are expected to have checked `canSendStory` already — this only
 * guards the file itself.
 */
export default async function openStoryComposer(peerId: PeerId) {
  let file: File;
  try {
    file = await requestFile('image/*, video/*');
  } catch(err) {
    return; // no file chosen
  }

  if(!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    toastNew({langPackKey: 'Stories.Composer.UnsupportedFile'});
    return;
  }

  let media: StoryMedia;
  try {
    media = await readMedia(file);
  } catch(err) {
    toastNew({langPackKey: 'Stories.Composer.UnsupportedFile'});
    return;
  }

  if(media.isVideo && media.duration > MAX_VIDEO_DURATION) {
    URL.revokeObjectURL(media.url);
    toastNew({langPackKey: 'Stories.Composer.VideoTooLong', langPackArguments: [MAX_VIDEO_DURATION]});
    return;
  }

  showStoryComposerPopup({peerId, media});
}
