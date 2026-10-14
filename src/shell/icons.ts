// Icons drawn by hand as small SVG shapes in a glossy early-2000s style, our own drawing. Generated pictures can replace
// any of them later (see GENERATED at the bottom); everything asks for an icon through icon(), so that swap touches this file only.
import { svg } from '../core/dom.ts';

export type IconName =
  | 'folder' | 'file' | 'text' | 'image' | 'video' | 'music' | 'pdf'
  | 'trash' | 'trash-full' | 'files' | 'gear' | 'info' | 'app'
  | 'editor' | 'photos' | 'player' | 'pdfviewer' | 'sheet' | 'archive' | 'code' | 'chip' | 'logo' | 'user' | 'lock'
  | 'calendar' | 'contacts' | 'link' | 'keyboard' | 'terminal' | 'calculator' | 'photoedit' | 'mail' | 'planet' | 'assistant' | 'chat' | 'panel'
  | 'printer' | 'modelsearch' | 'book' | 'projects' | 'write'
  | 'folder-desktop' | 'folder-documents' | 'folder-pictures' | 'folder-videos' | 'folder-music';

type Shape = [string, Record<string, string>];

const PAGE: Shape[] = [
  ['path', { d: 'M10 4h20l10 10v29a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', fill: 'url(#gi-paper)', stroke: '#8a97ab', 'stroke-width': '1.5' }],
  ['path', { d: 'M30 4v8a2 2 0 0 0 2 2h8', fill: '#dbe3ef', stroke: '#8a97ab', 'stroke-width': '1.5' }],
];

const FOLDER: Shape[] = [
  ['path', { d: 'M4 12a3 3 0 0 1 3-3h10l4 4h20a3 3 0 0 1 3 3v22a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z', fill: 'url(#gi-folder-back)' }],
  ['path', { d: 'M4 20a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z', fill: 'url(#gi-folder)' }],
  ['path', { d: 'M6 19h36', stroke: '#fff', 'stroke-opacity': '.55', 'stroke-width': '1.5', fill: 'none' }],
];

/** A folder with a small badge on its front flap. */
const badged = (...badge: Shape[]): Shape[] => [...FOLDER, ...badge];

export const STANDARD_FOLDERS = new Set<IconName>(['folder-desktop', 'folder-documents', 'folder-pictures', 'folder-videos', 'folder-music']);

const SHAPES: Record<IconName, Shape[]> = {
  folder: FOLDER,
  file: PAGE,
  text: [...PAGE, ['path', { d: 'M14 22h20M14 28h20M14 34h14', stroke: '#5b7db1', 'stroke-width': '2.2', 'stroke-linecap': 'round', fill: 'none' }]],
  image: [
    ['rect', { x: '5', y: '9', width: '38', height: '30', rx: '3', fill: 'url(#gi-paper)', stroke: '#6f88b3', 'stroke-width': '1.5' }],
    ['rect', { x: '8', y: '12', width: '32', height: '24', rx: '1.5', fill: 'url(#gi-sky)' }],
    ['path', { d: 'M8 36l10-11 7 7 5-5 10 9z', fill: '#4c9a53' }],
    ['circle', { cx: '32', cy: '19', r: '3.5', fill: '#ffe680' }],
  ],
  video: [
    ['rect', { x: '5', y: '9', width: '38', height: '30', rx: '3', fill: 'url(#gi-dark)', stroke: '#2b3550', 'stroke-width': '1.5' }],
    ['path', { d: 'M20 18l11 6-11 6z', fill: '#fff' }],
    ['path', { d: 'M9 12v2M9 17v2M9 22v2M9 27v2M9 32v2M39 12v2M39 17v2M39 22v2M39 27v2M39 32v2', stroke: '#9fb0d0', 'stroke-width': '2', fill: 'none' }],
  ],
  music: [
    ['circle', { cx: '24', cy: '24', r: '19', fill: 'url(#gi-blue)', stroke: '#2f5fa5', 'stroke-width': '1.5' }],
    ['path', { d: 'M20 31V15l12-3v16', stroke: '#fff', 'stroke-width': '2.6', 'stroke-linejoin': 'round', fill: 'none' }],
    ['circle', { cx: '17.5', cy: '31.5', r: '3.5', fill: '#fff' }],
    ['circle', { cx: '29.5', cy: '28.5', r: '3.5', fill: '#fff' }],
  ],
  pdf: [
    ...PAGE,
    ['rect', { x: '8', y: '26', width: '32', height: '13', rx: '2', fill: 'url(#gi-red)' }],
    ['path', { d: 'M13 36v-7h3a2 2 0 0 1 0 4h-3M22 36v-7h2a3.5 3.5 0 0 1 0 7zM31 36v-7h5M31 32.5h4', stroke: '#fff', 'stroke-width': '1.6', fill: 'none' }],
  ],
  trash: [
    ['path', { d: 'M12 15h24l-2 26a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3z', fill: 'url(#gi-bin)', stroke: '#5f7290', 'stroke-width': '1.5' }],
    ['rect', { x: '9', y: '10', width: '30', height: '5', rx: '2', fill: 'url(#gi-bin)', stroke: '#5f7290', 'stroke-width': '1.5' }],
    ['path', { d: 'M19 9V7a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v2M18 20v18M24 20v18M30 20v18', stroke: '#eaf0fa', 'stroke-width': '1.8', fill: 'none' }],
  ],
  'trash-full': [
    ['path', { d: 'M14 12l6-6 8 3 6-2 3 8z', fill: '#fff', stroke: '#8a97ab', 'stroke-width': '1.4' }],
    ['path', { d: 'M12 15h24l-2 26a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3z', fill: 'url(#gi-bin)', stroke: '#5f7290', 'stroke-width': '1.5' }],
    ['rect', { x: '9', y: '12', width: '30', height: '5', rx: '2', fill: 'url(#gi-bin)', stroke: '#5f7290', 'stroke-width': '1.5' }],
    ['path', { d: 'M18 21v17M24 21v17M30 21v17', stroke: '#eaf0fa', 'stroke-width': '1.8', fill: 'none' }],
  ],
  files: [
    ...FOLDER,
    ['circle', { cx: '33', cy: '32', r: '7', fill: 'url(#gi-sky)', stroke: '#2f5fa5', 'stroke-width': '2' }],
    ['path', { d: 'M38 37l5 5', stroke: '#2f5fa5', 'stroke-width': '3', 'stroke-linecap': 'round' }],
  ],
  gear: [
    ['path', { d: 'M21 4h6l1 5 4 2 4-3 4 4-3 4 2 4 5 1v6l-5 1-2 4 3 4-4 4-4-3-4 2-1 5h-6l-1-5-4-2-4 3-4-4 3-4-2-4-5-1v-6l5-1 2-4-3-4 4-4 4 3 4-2z', fill: 'url(#gi-gear)', stroke: '#5f7290', 'stroke-width': '1.4' }],
    ['circle', { cx: '24', cy: '24', r: '7', fill: 'url(#gi-blue)', stroke: '#2f5fa5', 'stroke-width': '1.5' }],
  ],
  // A person's head and shoulders on a blue disc, with a small gold key.
  user: [
    ['circle', { cx: '24', cy: '24', r: '19', fill: 'url(#gi-blue)', stroke: '#2f5fa5', 'stroke-width': '1.5' }],
    ['circle', { cx: '24', cy: '19', r: '7', fill: '#fdf6e8', stroke: '#2f5fa5', 'stroke-width': '1.2' }],
    ['path', { d: 'M11 37c2-7 7-10 13-10s11 3 13 10a19 19 0 0 1-26 0z', fill: '#fdf6e8', stroke: '#2f5fa5', 'stroke-width': '1.2' }],
    ['circle', { cx: '36', cy: '35', r: '4', fill: '#f2c14e', stroke: '#9a7412', 'stroke-width': '1.2' }],
    ['path', { d: 'M36 39v5m0-2h2', stroke: '#9a7412', 'stroke-width': '1.6', 'stroke-linecap': 'round', fill: 'none' }],
  ],
  // A gold padlock with a steel shackle.
  lock: [
    ['path', { d: 'M15 21v-5a9 9 0 0 1 18 0v5', fill: 'none', stroke: '#7d8aa0', 'stroke-width': '4', 'stroke-linecap': 'round' }],
    ['rect', { x: '9', y: '20', width: '30', height: '22', rx: '4', fill: '#f2c14e', stroke: '#9a7412', 'stroke-width': '1.5' }],
    ['circle', { cx: '24', cy: '29', r: '3.2', fill: '#5a4108' }],
    ['path', { d: 'M24 31v6', stroke: '#5a4108', 'stroke-width': '2.6', 'stroke-linecap': 'round' }],
  ],
  info: [
    ['circle', { cx: '24', cy: '24', r: '19', fill: 'url(#gi-blue)', stroke: '#2f5fa5', 'stroke-width': '1.5' }],
    ['path', { d: 'M24 21v13', stroke: '#fff', 'stroke-width': '4', 'stroke-linecap': 'round' }],
    ['circle', { cx: '24', cy: '14.5', r: '2.6', fill: '#fff' }],
  ],
  app: [
    ['rect', { x: '5', y: '8', width: '38', height: '32', rx: '3', fill: 'url(#gi-paper)', stroke: '#6f88b3', 'stroke-width': '1.5' }],
    ['rect', { x: '5', y: '8', width: '38', height: '8', rx: '3', fill: 'url(#gi-blue)' }],
  ],
  // A desk calendar: red top band, rings, and a date grid.
  calendar: [
    ['rect', { x: '6', y: '9', width: '36', height: '33', rx: '3', fill: 'url(#gi-paper)', stroke: '#8a97ab', 'stroke-width': '1.5' }],
    ['rect', { x: '6', y: '9', width: '36', height: '10', rx: '3', fill: 'url(#gi-red)' }],
    ['path', { d: 'M15 5v8M33 5v8', stroke: '#5f7290', 'stroke-width': '2.6', 'stroke-linecap': 'round', fill: 'none' }],
    ['path', { d: 'M12 25h5M21.5 25h5M31 25h5M12 31h5M21.5 31h5M31 31h5M12 37h5M21.5 37h5', stroke: '#7d9cd0', 'stroke-width': '2.6', 'stroke-linecap': 'round', fill: 'none' }],
    ['rect', { x: '29.5', y: '34', width: '8', height: '6', rx: '1', fill: 'url(#gi-blue)' }],
  ],
  // A clipboard with a ticked list and a star: My Projects.
  projects: [
    ['rect', { x: '8', y: '7', width: '32', height: '36', rx: '3', fill: 'url(#gi-card)', stroke: '#8a6a30', 'stroke-width': '1.5' }],
    ['rect', { x: '12', y: '12', width: '24', height: '27', rx: '1.5', fill: 'url(#gi-paper)', stroke: '#9aa7bd', 'stroke-width': '1' }],
    ['rect', { x: '17', y: '4', width: '14', height: '7', rx: '2', fill: 'url(#gi-gear)', stroke: '#5f7290', 'stroke-width': '1.2' }],
    ['path', { d: 'M15 20l2 2 3.5-4M15 28l2 2 3.5-4', stroke: '#2e7d5b', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }],
    ['path', { d: 'M23 20.5h9M23 28.5h5', stroke: '#7d9cd0', 'stroke-width': '2.2', 'stroke-linecap': 'round', fill: 'none' }],
    ['path', { d: 'M33 27l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z', fill: '#f2b51d', stroke: '#a8740a', 'stroke-width': '1', 'stroke-linejoin': 'round' }],
  ],
  // An address card with a head-and-shoulders figure.
  contacts: [
    ['rect', { x: '5', y: '9', width: '38', height: '30', rx: '3', fill: 'url(#gi-card)', stroke: '#8a6a30', 'stroke-width': '1.5' }],
    ['circle', { cx: '16', cy: '21', r: '5', fill: 'url(#gi-blue)', stroke: '#2a5fb8', 'stroke-width': '1.2' }],
    ['path', { d: 'M8 34a8 7 0 0 1 16 0z', fill: 'url(#gi-blue)', stroke: '#2a5fb8', 'stroke-width': '1.2' }],
    ['path', { d: 'M28 19h10M28 25h10M28 31h7', stroke: '#8a6a30', 'stroke-width': '2.2', 'stroke-linecap': 'round', fill: 'none' }],
  ],
  // A globe with a chain link.
  link: [
    ['circle', { cx: '22', cy: '22', r: '16', fill: 'url(#gi-sky)', stroke: '#2f5fa5', 'stroke-width': '1.8' }],
    ['path', { d: 'M6 22h32M22 6c-6 5-6 27 0 32M22 6c6 5 6 27 0 32', stroke: '#2f5fa5', 'stroke-width': '1.4', fill: 'none' }],
    ['rect', { x: '26', y: '30', width: '16', height: '9', rx: '4.5', fill: 'none', stroke: '#5f7290', 'stroke-width': '3', transform: 'rotate(-35 34 34.5)' }],
  ],
  // A terminal window: dark screen, green prompt, cursor block.
  terminal: [
    ['rect', { x: '4', y: '7', width: '40', height: '34', rx: '3', fill: 'url(#gi-dark)', stroke: '#141b2e', 'stroke-width': '1.5' }],
    ['rect', { x: '4', y: '7', width: '40', height: '6', rx: '3', fill: 'url(#gi-gear)' }],
    ['path', { d: 'M10 20l6 5-6 5', stroke: '#5be26b', 'stroke-width': '2.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }],
    ['rect', { x: '19', y: '29', width: '9', height: '3', fill: '#e6e9ef' }],
  ],
  // A keyboard.
  keyboard: [
    ['rect', { x: '4', y: '13', width: '40', height: '23', rx: '3', fill: 'url(#gi-gear)', stroke: '#5f7290', 'stroke-width': '1.5' }],
    ['path', { d: 'M10 20h3M16 20h3M22 20h3M28 20h3M34 20h3M10 25.5h3M16 25.5h3M22 25.5h3M28 25.5h3M34 25.5h3M15 31h18', stroke: '#3a4a72', 'stroke-width': '2.6', 'stroke-linecap': 'round', fill: 'none' }],
  ],
  // A spiral notepad with a pencil.
  editor: [
    ['rect', { x: '8', y: '8', width: '26', height: '34', rx: '2', fill: 'url(#gi-paper)', stroke: '#8a97ab', 'stroke-width': '1.5' }],
    ['path', { d: 'M13 5v6M19 5v6M25 5v6M31 5v6', stroke: '#5f7290', 'stroke-width': '2.4', 'stroke-linecap': 'round', fill: 'none' }],
    ['path', { d: 'M13 19h16M13 25h16M13 31h9', stroke: '#7d9cd0', 'stroke-width': '2', 'stroke-linecap': 'round', fill: 'none' }],
    ['path', { d: 'M24 42l1.5-7 14-14 5.5 5.5-14 14z', fill: 'url(#gi-folder)', stroke: '#a06f10', 'stroke-width': '1.2', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M24 42l1.5-7 5.5 5.5z', fill: '#f3dcb5', stroke: '#a06f10', 'stroke-width': '1' }],
    ['path', { d: 'M39.5 21l2-2a2.6 2.6 0 0 1 3.7 0l1.8 1.8a2.6 2.6 0 0 1 0 3.7l-2 2z', fill: '#e4746c', stroke: '#a3362d', 'stroke-width': '1.1' }],
  ],
  // Two snapshots, one tilted behind the other.
  photos: [
    ['rect', { x: '8', y: '9', width: '28', height: '23', rx: '2', fill: 'url(#gi-paper)', stroke: '#8a97ab', 'stroke-width': '1.4', transform: 'rotate(-9 22 20)' }],
    ['rect', { x: '11', y: '13', width: '30', height: '26', rx: '2', fill: 'url(#gi-paper)', stroke: '#6f88b3', 'stroke-width': '1.5' }],
    ['rect', { x: '14', y: '16', width: '24', height: '15', fill: 'url(#gi-sky)' }],
    ['path', { d: 'M14 31l8-9 5 5 4-4 7 8z', fill: '#4c9a53' }],
    ['circle', { cx: '32', cy: '21', r: '2.6', fill: '#ffe680' }],
  ],
  // A speech bubble with a small spark: the AI (Chat › Agents, the Panel's AI link).
  assistant: [
    ['path', { d: 'M8 10h32a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H22l-8 7v-7H8a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3z', fill: 'url(#gi-paper)', stroke: '#5f7290', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M24 14l2.2 5.3L31.5 21.5l-5.3 2.2L24 29l-2.2-5.3-5.3-2.2 5.3-2.2z', fill: '#a855f7', stroke: '#6b21a8', 'stroke-width': '1' }],
    ['circle', { cx: '35', cy: '16', r: '1.8', fill: '#f5a524' }],
  ],
  // An open book with a ribbon: the Reader.
  book: [
    ['path', { d: 'M5 11c6-2.5 12-2.5 19 1 7-3.5 13-3.5 19-1v28c-6-2.5-12-2.5-19 1-7-3.5-13-3.5-19-1z', fill: 'url(#gi-paper)', stroke: '#5f7290', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M24 12v28', stroke: '#5f7290', 'stroke-width': '1.4' }],
    ['path', { d: 'M10 18h9M10 23h9M10 28h7M29 18h9M29 23h9M29 28h7', stroke: '#9aa7bd', 'stroke-width': '1.4', 'stroke-linecap': 'round' }],
    ['path', { d: 'M33 8v11l2.5-2 2.5 2V8z', fill: '#2e7d5b' }],
  ],
  // A chip under a magnifying glass: finding AI models.
  modelsearch: [
    ['rect', { x: '7', y: '9', width: '22', height: '22', rx: '3', fill: '#3b4a63', stroke: '#1f2a3c', 'stroke-width': '1.5' }],
    ['path', { d: 'M12 6v3M18 6v3M24 6v3M12 31v3M18 31v3M24 31v3M4 14h3M4 20h3M4 26h3', stroke: '#8a97ab', 'stroke-width': '1.6', 'stroke-linecap': 'round' }],
    ['circle', { cx: '30', cy: '28', r: '8', fill: 'rgba(200,225,255,.85)', stroke: '#1f5fbf', 'stroke-width': '2.4' }],
    ['path', { d: 'M36 34l7 7', stroke: '#1f5fbf', 'stroke-width': '3.6', 'stroke-linecap': 'round' }],
  ],
  // A ringed planet with a small moon.
  planet: [
    ['circle', { cx: '24', cy: '24', r: '12', fill: '#3d8bfd', stroke: '#1a4a9c', 'stroke-width': '1.5' }],
    ['path', { d: 'M17 18c3 2 9 2 13-1M15 26c5 1 12 1 18-2', stroke: '#9cc3ff', 'stroke-width': '1.6', fill: 'none', 'stroke-linecap': 'round' }],
    ['ellipse', { cx: '24', cy: '26', rx: '21', ry: '6', fill: 'none', stroke: '#f5a524', 'stroke-width': '2.2', transform: 'rotate(-18 24 26)' }],
    ['circle', { cx: '40', cy: '9', r: '3.5', fill: '#d6d9e0', stroke: '#6b7280', 'stroke-width': '1' }],
  ],
  // A desk printer: paper in the back, a printed sheet coming out the front, a green light.
  printer: [
    ['rect', { x: '13', y: '4', width: '22', height: '16', rx: '1', fill: 'url(#gi-paper)', stroke: '#8a97ab', 'stroke-width': '1.4' }],
    ['path', { d: 'M7 17h34a4 4 0 0 1 4 4v13a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V21a4 4 0 0 1 4-4z', fill: 'url(#gi-gear)', stroke: '#5f7290', 'stroke-width': '1.6' }],
    ['path', { d: 'M8 22h22', stroke: '#fff', 'stroke-opacity': '.7', 'stroke-width': '1.6', 'stroke-linecap': 'round', fill: 'none' }],
    ['circle', { cx: '38', cy: '23', r: '2', fill: '#34c759', stroke: '#1f7a37', 'stroke-width': '.8' }],
    ['rect', { x: '11', y: '29', width: '26', height: '15', rx: '1', fill: 'url(#gi-paper)', stroke: '#8a97ab', 'stroke-width': '1.4' }],
    ['path', { d: 'M15 34h18M15 38.5h12', stroke: '#00a3d9', 'stroke-width': '2', 'stroke-linecap': 'round', fill: 'none' }],
  ],
  // Two speech bubbles, one behind the other.
  chat: [
    ['path', { d: 'M6 9h24a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3H15l-6 5v-5H6a3 3 0 0 1-3-3V12a3 3 0 0 1 3-3z', fill: 'url(#gi-blue)', stroke: '#2f5fa5', 'stroke-width': '1.5' }],
    ['path', { d: 'M20 21h22a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3h-2v5l-6-5H20a3 3 0 0 1-3-3V24a3 3 0 0 1 3-3z', fill: 'url(#gi-paper)', stroke: '#5f7290', 'stroke-width': '1.5' }],
    ['path', { d: 'M23 28h16M23 33h11', stroke: '#7d9cd0', 'stroke-width': '2.2', 'stroke-linecap': 'round', fill: 'none' }],
  ],
  // A dark console: a bar along the top, a rail down the left with one line lit, and panes to the right.
  panel: [
    ['rect', { x: '4', y: '7', width: '40', height: '34', rx: '3', fill: '#1d2733', stroke: '#141b2e', 'stroke-width': '1.5' }],
    ['rect', { x: '4', y: '7', width: '40', height: '6', rx: '3', fill: '#2d3a4b' }],
    ['rect', { x: '7', y: '16', width: '10', height: '22', rx: '1', fill: '#131920' }],
    ['path', { d: 'M9 20h6M9 29h6M9 33h6', stroke: '#8a96a6', 'stroke-width': '1.8', 'stroke-linecap': 'round', fill: 'none' }],
    ['path', { d: 'M9 24.5h6', stroke: '#5b9bd5', 'stroke-width': '2.4', 'stroke-linecap': 'round', fill: 'none' }],
    ['rect', { x: '20', y: '16', width: '21', height: '9', rx: '1.5', fill: '#2a3340' }],
    ['rect', { x: '20', y: '28', width: '10', height: '10', rx: '1.5', fill: '#2a3340' }],
    ['rect', { x: '32', y: '28', width: '9', height: '10', rx: '1.5', fill: '#4caf7a' }],
  ],
  // An envelope with its flap folded down.
  mail: [
    ['rect', { x: '5', y: '11', width: '38', height: '27', rx: '2.5', fill: 'url(#gi-paper)', stroke: '#5f7290', 'stroke-width': '1.6' }],
    ['path', { d: 'M6 13l18 14 18-14', fill: 'none', stroke: '#5f7290', 'stroke-width': '1.8', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M6 37l13-12M42 37L29 25', fill: 'none', stroke: '#8a97ab', 'stroke-width': '1.3' }],
  ],
  // A picture with a paintbrush across its corner.
  photoedit: [
    ['rect', { x: '6', y: '10', width: '30', height: '26', rx: '2', fill: 'url(#gi-paper)', stroke: '#6f88b3', 'stroke-width': '1.5' }],
    ['rect', { x: '9', y: '13', width: '24', height: '16', fill: 'url(#gi-sky)' }],
    ['path', { d: 'M9 29l7-8 5 5 4-4 8 7z', fill: '#4c9a53' }],
    ['path', { d: 'M27 38l14-18 3.5 2.6-13 18.4z', fill: '#c9954a', stroke: '#7a5520', 'stroke-width': '1.1', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M27 38c-2 1-3.5 3.6-3 6 2.6.2 5.6-1.2 6.5-3.5z', fill: '#d62828', stroke: '#8a1616', 'stroke-width': '1' }],
  ],
  // A small screen on a stand, with a play triangle.
  player: [
    ['rect', { x: '5', y: '7', width: '38', height: '27', rx: '3', fill: 'url(#gi-dark)', stroke: '#2b3550', 'stroke-width': '1.5' }],
    ['rect', { x: '8.5', y: '10.5', width: '31', height: '20', rx: '1.5', fill: 'url(#gi-blue)' }],
    ['path', { d: 'M20 15l11 6-11 6z', fill: '#fff' }],
    ['path', { d: 'M20 34v4M28 34v4', stroke: '#5f7290', 'stroke-width': '3', fill: 'none' }],
    ['rect', { x: '12', y: '38', width: '24', height: '4', rx: '2', fill: 'url(#gi-gear)', stroke: '#5f7290', 'stroke-width': '1.2' }],
  ],
  // A page with a red band, and a magnifying glass over it.
  pdfviewer: [
    ...PAGE,
    ['rect', { x: '8', y: '24', width: '26', height: '10', rx: '2', fill: 'url(#gi-red)' }],
    ['path', { d: 'M13 20h14M13 15h10', stroke: '#8a97ab', 'stroke-width': '2', 'stroke-linecap': 'round', fill: 'none' }],
    ['circle', { cx: '32', cy: '32', r: '8', fill: 'url(#gi-sky)', 'fill-opacity': '.75', stroke: '#2f5fa5', 'stroke-width': '2.2' }],
    ['path', { d: 'M38 38l6 6', stroke: '#2f5fa5', 'stroke-width': '3.4', 'stroke-linecap': 'round', fill: 'none' }],
  ],
  // A page of writing: a blue heading line, grey text lines, and a blue capital W in the corner.
  write: [
    ...PAGE,
    ['path', { d: 'M14 17h14', stroke: '#2f5fa5', 'stroke-width': '3', 'stroke-linecap': 'round', fill: 'none' }],
    ['path', { d: 'M14 24h20M14 29h20M14 34h11', stroke: '#8a97ab', 'stroke-width': '2', 'stroke-linecap': 'round', fill: 'none' }],
    ['rect', { x: '25', y: '30', width: '16', height: '13', rx: '2', fill: '#2f5fa5', stroke: '#1b3f7a', 'stroke-width': '1' }],
    ['path', { d: 'M28 33l2 7 3-5 3 5 2-7', stroke: '#fff', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', fill: 'none' }],
  ],
  // A page with a small grid, the top row green.
  sheet: [
    ...PAGE,
    ['rect', { x: '12', y: '20', width: '24', height: '19', fill: '#fff', stroke: '#1e7a45', 'stroke-width': '1.4' }],
    ['rect', { x: '12', y: '20', width: '24', height: '6', fill: 'url(#gi-green)', stroke: '#1e7a45', 'stroke-width': '1.4' }],
    ['path', { d: 'M12 32.5h24M20 20v19M28 20v19', stroke: '#1e7a45', 'stroke-width': '1.2', fill: 'none' }],
  ],
  // A cardboard box with a zip down the lid.
  archive: [
    ['rect', { x: '7', y: '15', width: '34', height: '27', rx: '2', fill: 'url(#gi-card)', stroke: '#8a6a30', 'stroke-width': '1.5' }],
    ['rect', { x: '5', y: '8', width: '38', height: '9', rx: '2', fill: '#f0d3a2', stroke: '#8a6a30', 'stroke-width': '1.5' }],
    ['path', { d: 'M24 8v26', stroke: '#5f7290', 'stroke-width': '3', 'stroke-dasharray': '2.2 2', fill: 'none' }],
    ['rect', { x: '20.5', y: '32', width: '7', height: '8', rx: '1.5', fill: 'url(#gi-bin)', stroke: '#5f7290', 'stroke-width': '1.3' }],
  ],
  // A grey calculator: green display, three rows of keys, an orange equals.
  calculator: [
    ['rect', { x: '9', y: '4', width: '30', height: '40', rx: '4', fill: '#e9ecf1', stroke: '#5f7290', 'stroke-width': '1.6' }],
    ['rect', { x: '13', y: '8', width: '22', height: '9', rx: '1.5', fill: '#cfe8c8', stroke: '#4d7a45', 'stroke-width': '1.2' }],
    ['path', { d: 'M15 23h4M22 23h4M29 23h4M15 30h4M22 30h4M15 37h4M22 37h4', stroke: '#5f7290', 'stroke-width': '3.6', 'stroke-linecap': 'round', fill: 'none' }],
    ['rect', { x: '28', y: '27.5', width: '6', height: '11.5', rx: '2', fill: '#e8913a', stroke: '#a3591a', 'stroke-width': '1' }],
  ],
  // A page with angle brackets.
  code: [
    ...PAGE,
    ['path', { d: 'M19 24l-6 6 6 6M29 24l6 6-6 6M26 22l-4 16', stroke: '#2a5fb8', 'stroke-width': '2.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }],
  ],
  // A processor chip with gold pins and a green light.
  chip: [
    ['path', { d: 'M17 5v6M24 5v6M31 5v6M17 37v6M24 37v6M31 37v6M5 17h6M5 24h6M5 31h6M37 17h6M37 24h6M37 31h6', stroke: '#d9a12a', 'stroke-width': '2.6', 'stroke-linecap': 'round', fill: 'none' }],
    ['rect', { x: '10', y: '10', width: '28', height: '28', rx: '3', fill: 'url(#gi-dark)', stroke: '#141b2e', 'stroke-width': '1.5' }],
    ['rect', { x: '16', y: '16', width: '16', height: '16', rx: '2', fill: '#3a4a72', stroke: '#7a8fbf', 'stroke-width': '1.2' }],
    ['circle', { cx: '33', cy: '15', r: '1.8', fill: '#5be26b' }],
  ],
  // The TOMLIN OS mark: a rounded blue tile with an open window under a smile-shaped title bar.
  logo: [
    ['rect', { x: '4', y: '4', width: '40', height: '40', rx: '10', fill: 'url(#gi-blue)', stroke: '#2a5fb8', 'stroke-width': '1.5' }],
    ['rect', { x: '10.5', y: '12', width: '27', height: '23', rx: '3', fill: '#fff' }],
    ['path', { d: 'M12 20q12 6.5 24 0', stroke: '#3f7fd8', 'stroke-width': '3.2', 'stroke-linecap': 'round', fill: 'none' }],
    ['circle', { cx: '15.5', cy: '16', r: '1.6', fill: '#3f7fd8' }],
  ],
  'folder-desktop': badged(
    ['rect', { x: '16', y: '24', width: '16', height: '10', rx: '1.6', fill: 'url(#gi-blue)', stroke: '#2a5fb8', 'stroke-width': '1.2' }],
    ['path', { d: 'M21 37h6M24 34v3', stroke: '#5f7290', 'stroke-width': '1.8', 'stroke-linecap': 'round', fill: 'none' }],
  ),
  'folder-documents': badged(
    ['rect', { x: '18', y: '23', width: '12', height: '15', rx: '1', fill: '#fff', stroke: '#8a97ab', 'stroke-width': '1.2' }],
    ['path', { d: 'M20.5 28h7M20.5 31.5h7M20.5 35h4', stroke: '#7d9cd0', 'stroke-width': '1.4', 'stroke-linecap': 'round', fill: 'none' }],
  ),
  'folder-pictures': badged(
    ['rect', { x: '16', y: '24', width: '16', height: '12', rx: '1', fill: 'url(#gi-sky)', stroke: '#6f88b3', 'stroke-width': '1.2' }],
    ['path', { d: 'M16 36l5-6 4 4 3-3 4 5z', fill: '#4c9a53' }],
  ),
  'folder-videos': badged(
    ['rect', { x: '16', y: '24', width: '16', height: '12', rx: '1.4', fill: 'url(#gi-dark)', stroke: '#2b3550', 'stroke-width': '1.2' }],
    ['path', { d: 'M22 27.5l6.5 2.5-6.5 2.5z', fill: '#fff' }],
  ),
  'folder-music': badged(
    ['path', { d: 'M22 36V26l8-2v10', stroke: '#c9700f', 'stroke-width': '2.2', 'stroke-linejoin': 'round', fill: 'none' }],
    ['circle', { cx: '20.5', cy: '36', r: '2.6', fill: '#f39c34', stroke: '#c9700f', 'stroke-width': '1' }],
    ['circle', { cx: '28.5', cy: '34', r: '2.6', fill: '#f39c34', stroke: '#c9700f', 'stroke-width': '1' }],
  ),
};

function gradient(id: string, stops: Array<[string, string]>): SVGElement {
  return svg(
    'linearGradient',
    { id, x1: '0', y1: '0', x2: '0', y2: '1' },
    ...stops.map(([offset, color]) => svg('stop', { offset, 'stop-color': color })),
  );
}

/** Shared gradients, added to the page once; every icon refers to them by id. */
export function iconDefs(): SVGElement {
  return svg(
    'svg',
    { width: '0', height: '0', 'aria-hidden': 'true', focusable: 'false', class: 'icon-defs' },
    svg(
      'defs',
      {},
      gradient('gi-folder', [['0', '#ffe9a0'], ['.5', '#f7c948'], ['1', '#e4a91f']]),
      gradient('gi-folder-back', [['0', '#d9a12a'], ['1', '#b57f12']]),
      gradient('gi-paper', [['0', '#ffffff'], ['1', '#e3e9f3']]),
      gradient('gi-sky', [['0', '#8fd0ff'], ['1', '#d6efff']]),
      gradient('gi-dark', [['0', '#4a5878'], ['1', '#1f2740']]),
      gradient('gi-blue', [['0', '#7db4f5'], ['.5', '#3f7fd8'], ['1', '#2a5fb8']]),
      gradient('gi-red', [['0', '#f28c85'], ['1', '#c9342b']]),
      gradient('gi-bin', [['0', '#e7eef9'], ['1', '#a9b9d3']]),
      gradient('gi-gear', [['0', '#e9eef7'], ['1', '#9aa9c4']]),
      gradient('gi-green', [['0', '#8fd694'], ['1', '#2f9a4a']]),
      gradient('gi-card', [['0', '#f0d3a2'], ['1', '#cfa262']]),
    ),
  );
}

/** Icons that have a generated picture in public/icons/<name>.png. The rest are drawn from the shapes above. */
const GENERATED = new Set<IconName>([]);

/** True for a name this desktop can draw (a store app names its icon in the signed catalogue). */
export function isIconName(name: string): name is IconName {
  return GENERATED.has(name as IconName) || Object.hasOwn(SHAPES, name);
}

export function icon(name: IconName, size = 48): SVGElement {
  if (GENERATED.has(name)) {
    return svg('svg', { viewBox: '0 0 48 48', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: 'icon' }, svg('image', { href: `icons/${name}.png`, width: 48, height: 48 }));
  }
  return svg(
    'svg',
    { viewBox: '0 0 48 48', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: 'icon' },
    ...SHAPES[name].map(([tag, attrs]) => svg(tag, attrs)),
  );
}
