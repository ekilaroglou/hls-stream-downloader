// Small line icons (24x24, drawn with currentColor). Static markup only.
const SHAPES = {
  logo: '<rect x="3.5" y="3.5" width="17" height="12" rx="3" fill="currentColor" stroke="none"/><path d="M10.2 6.6v5.8l4.8-2.9z" fill="#f2701f" stroke="#f2701f" stroke-width="1"/><path d="M12 17.5v3.2M9.6 18.9 12 21.3l2.4-2.4" stroke-width="2.2"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  layers: '<path d="m12 4 8.5 4.25L12 12.5 3.5 8.25z"/><path d="m3.5 12.25 8.5 4.25 8.5-4.25"/><path d="m3.5 16.25 8.5 4.25 8.5-4.25"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  play: '<path d="M9 6.5v11l9-5.5z" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  back: '<path d="M14.5 6 8.5 12l6 6"/>',
  lock: '<rect x="5.5" y="11" width="13" height="9" rx="2"/><path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11"/>',
  retry: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  leaf: '<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19 13 11"/>',
  gauge: '<path d="M4.5 16a8 8 0 1 1 15 0"/><path d="m12 13 3.5-4"/>',
  bolt: '<path d="M13 3.5 5.5 13H12l-1 7.5L18.5 11H12z"/>',
  rocket: '<path d="M12 3c3 2.4 4 5.8 4 9.5V16H8v-3.5C8 8.8 9 5.4 12 3z"/><path d="M8 12.5 5.5 15v3H8M16 12.5l2.5 2.5v3H16"/><circle cx="12" cy="9.5" r="1.6"/><path d="M10.5 19.5c0 .9.6 1.7 1.5 2.2.9-.5 1.5-1.3 1.5-2.2"/>',
  dialog: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 8.5h17M7.5 12.5h9M7.5 15.5h5.5"/>',
  film: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m10 9.5 4.5 2.5-4.5 2.5z" fill="currentColor"/>',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = SHAPES[name] || '';
  return svg;
}
