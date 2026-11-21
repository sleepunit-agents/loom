const clamp = (n: number) => Math.max(0, Math.min(1, n));
type Dissolve = 'matrix' | 'hexagon';

// Each mask repeats horizontally or in both dimensions. The same geometry drives the
// luminous edge and the browser's snapshot of the window, including scrolled content.
function layers(effect: Dissolve, width: number, height: number, p: number) {
  const step = Math.max(18, Math.ceil(width / 80));
  const tileWidth = effect === 'matrix' ? step * 11 : step * 3;
  const pitch = Math.sqrt(3) * step;
  const tileHeight = effect === 'matrix' ? height : pitch;
  let mask = '', ink = '';
  if (effect === 'matrix') {
    for (let i = 0; i < 11; i++) {
      const t = clamp((p * 1.32 - ((i * 7) % 11) / 34));
      const y = Math.round(height * t), x = i * step;
      mask += '<rect x="'+x+'" y="'+y+'" width="'+step+'" height="'+(height-y)+'"/>';
      if (t > 0 && t < 1) {
        for (let j = 0; j < 3; j++) {
          const glyph = '01+:/<>F'[(i + j + Math.floor(t * 21)) % 8];
          const escaped = glyph === '<' ? '&lt;' : glyph === '>' ? '&gt;' : glyph;
          ink += '<text x="'+(x+3)+'" y="'+(y-j*15)+'" fill="'+['#c6ffe5','#52dba8','#288f78'][j]+'">'+escaped+'</text>';
        }
      }
    }
  } else {
    for (let col = 0; col <= 2; col++) {
      for (let row = -1; row <= 1; row++) {
        const cx = col * step * 1.5, cy = (row + col % 2 / 2) * pitch;
        const r = step * (1 - clamp((p * 1.15 - col % 2 * .15)) ** 1.6);
        const points = Array.from({length:6}, (_, i) => {
          const a = i * Math.PI / 3;
          return (cx+r*Math.cos(a)).toFixed(2)+','+(cy+r*Math.sin(a)).toFixed(2);
        }).join(' ');
        mask += '<polygon points="'+points+'" stroke="white" stroke-width=".8"/>';
        if (p > 0 && p < 1) ink += '<polygon points="'+points+'" fill="none" stroke="#89ecf5" stroke-opacity="'+Math.sin(Math.PI*p).toFixed(2)+'"/>';
      }
    }
  }
  function image(body: string) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+tileWidth+'" height="'+tileHeight+'" viewBox="0 0 '+tileWidth+' '+tileHeight+'" fill="white" font-family="monospace" font-size="14">'+body+'</svg>';
    return 'url("data:image/svg+xml,'+encodeURIComponent(svg)+'")';
  }
  return {maskImage: p === 0 ? 'none' : image(p === 1 ? '' : mask), backgroundImage: image(ink)};
}

export function animateDissolve(effect: Dissolve, width: number, height: number, duration: number) {
  const frames = Array.from({length:25}, (_, index) => layers(effect,width,height,index/24));
  const timing = {duration, easing:'linear', fill:'both' as const};
  const root = document.documentElement;
  return [
    root.animate(frames.map(({maskImage}) => ({maskImage})), {...timing,pseudoElement:'::view-transition-old(loom-departure)'}),
    root.animate(frames.map(({backgroundImage}) => ({backgroundImage})), {...timing,pseudoElement:'::view-transition-image-pair(loom-departure)'}),
  ];
}
