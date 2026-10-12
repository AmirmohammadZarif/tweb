// Andropay "A" monogram (brand book "Logo versions" p.5), drawn in
// `currentColor` so it follows whatever the host button's color is.
const VIEW_BOX = '0 0 9.8327 12.8366';
const TRANSFORM = 'matrix(1,0,0,-1,5.2256,5.8888)';
const PATH = 'M0 0-1.883-1.435C-2.251-1.715-2.784-1.453-2.784-.987V1.876C-2.784 2.342-2.251 2.604-1.883 2.324L0 .89C.295 .666 .295 .224 0 0M3.683 .86-2.186 5.327C-3.338 6.205-4.99 5.382-4.99 3.939V-4.997C-4.99-6.441-3.337-7.262-2.187-6.388L-2.017-6.259C-1.746-6.053-1.593-5.728-1.604-5.388L-1.646-4.276C-1.659-3.908-1.486-3.557-1.186-3.343L.921-1.848C1.3-1.579 1.807-1.579 2.186-1.846L2.388-1.989C2.761-2.251 3.261-2.242 3.624-1.966L3.683-1.921C4.602-1.22 4.602 .162 3.683 .86';

const SVG_NS = 'http://www.w3.org/2000/svg';

export default function AndropayMark(...classes: string[]) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', VIEW_BOX);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('andropay-mark', ...classes);

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('transform', TRANSFORM);
  path.setAttribute('d', PATH);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);

  return svg;
}
