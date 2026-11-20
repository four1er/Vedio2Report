// Only static, application-owned paths enter icon markup.
const paths: Record<string, string> = {
  pen: '<path d="m15 5 4 4M4 20l4.5-1L20 7.5a2.8 2.8 0 0 0-4-4L4.5 15z"/><path d="M12 20h8"/>',
  link: '<path d="m10 13 4-4m-6 3-2 2a3.5 3.5 0 0 0 5 5l3-3m-4-8 3-3a3.5 3.5 0 0 1 5 5l-2 2"/>',
  corner: '<path d="M19 5v5a3 3 0 0 1-3 3H5m4-4-4 4 4 4"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  'arrow-up-right': '<path d="M6 18 18 6M8 6h10v10"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h4"/>',
  download: '<path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  sparkles: '<path d="M11 2c1.1 6.2 3.4 8.5 9.6 9.6-6.2 1.1-8.5 3.4-9.6 9.6-1.1-6.2-3.4-8.5-9.6-9.6C7.6 10.5 9.9 8.2 11 2Z" fill="currentColor" stroke="none"/>',
  github: '<path fill="currentColor" stroke="none" d="M12 .9a11.1 11.1 0 0 0-3.5 21.6c.55.1.76-.24.76-.54v-2.1c-3.1.68-3.75-1.3-3.75-1.3-.5-1.3-1.24-1.65-1.24-1.65-1.01-.69.08-.68.08-.68 1.12.08 1.7 1.15 1.7 1.15.99 1.7 2.6 1.2 3.24.92.1-.72.38-1.21.7-1.5-2.48-.29-5.1-1.24-5.1-5.48 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.12-2.95 0 0 .94-.3 3.06 1.15a10.6 10.6 0 0 1 5.56 0c2.12-1.45 3.05-1.15 3.05-1.15.63 1.53.25 2.67.12 2.95.72.78 1.15 1.78 1.15 3 0 4.26-2.63 5.19-5.13 5.47.4.35.75 1.03.75 2.07v3.1c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"/>',
};
export function applyIcons() {
  for (const holder of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    const path = paths[holder.dataset.icon!];
    if (path) holder.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
}
