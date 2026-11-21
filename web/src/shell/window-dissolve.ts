const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Render the effect at the window's original size. The dock trajectory moves the frame separately. */
export function drawDissolve(frame: HTMLElement, effect: 'matrix' | 'hexagon', duration: number) {
  const canvas = document.createElement('canvas');
  const width = frame.clientWidth, height = frame.clientHeight;
  if (!width || !height) return;
  canvas.width = width;
  canvas.height = height;
  frame.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const paint = effect === 'matrix' ? matrix(ctx, width, height) : hexagons(ctx, width, height);
  const start = performance.now();
  function tick(now: number) {
    if (!frame.isConnected) return;
    const progress = clamp((now - start) / duration);
    paint(progress);
    if (progress < 1) requestAnimationFrame(tick);
  }
  tick(start);
}

function matrix(ctx: CanvasRenderingContext2D, width: number, height: number) {
  // Paint the type once. Each strip then has its own speed, starting row and bright leading glyph.
  const sheet = document.createElement('canvas');
  const step = Math.max(17, Math.ceil(width / 100));
  sheet.width = width;
  sheet.height = height + step;
  const ink = sheet.getContext('2d')!;
  ink.font = '14px monospace';
  const alphabet = '0123456789ABCDEF:<>+=';
  const columns = Math.ceil(width / step);
  for (let col = 0; col < columns; col++) {
    for (let row = 0; row * step < sheet.height; row++) {
      const digit = ((row + 7) * (col + 13) * 31 + row * 7 + col) >>> 0;
      ink.fillStyle = ['#27ac75', '#65e39a', '#21835f', '#81f9ad'][digit % 4];
      ink.fillText(alphabet[digit % alphabet.length], col * step + 2, (row + 1) * step - 2);
    }
  }
  return (p: number) => {
    ctx.clearRect(0, 0, width, height);
    ctx.font = ink.font;
    for (let col = 0; col < columns; col++) {
      const t = clamp((p - ((col * 17) % 23) / 110) / .77);
      const x = col * step, y = Math.floor(height * t * t);
      if (y >= height) continue;
      ctx.fillStyle = '#071b12';
      ctx.fillRect(x, y, step, height - y);
      const drift = Math.floor(t * step * (4 + col % 7)) % step;
      ctx.drawImage(sheet, x, step - drift, step, height - y, x, y, step, height - y);
      ctx.fillStyle = '#c7ffda';
      ctx.fillText(alphabet[(col + Math.floor(t * 32)) % alphabet.length], x + 2, y + step - 2);
    }
  };
}

function hexagons(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const radius = Math.max(18, Math.ceil(width / 45));
  const pitch = Math.sqrt(3) * radius;
  const cells: { x: number; y: number; delay: number }[] = [];
  for (let col = 0; col * radius * 1.5 < width + radius; col++) {
    for (let row = -1; row * pitch < height + pitch; row++) {
      const x = col * radius * 1.5, y = (row + (col % 2) / 2) * pitch;
      cells.push({ x, y, delay: .48 * Math.hypot((x - width / 2) / width, (y - height / 2) / height) });
    }
  }
  const hex = new Path2D();
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    if (i === 0) hex.moveTo(radius, 0);
    else hex.lineTo(radius * Math.cos(angle), radius * Math.sin(angle));
  }
  hex.closePath();
  return (p: number) => {
    ctx.clearRect(0, 0, width, height);
    for (const {x, y, delay} of cells) {
      const t = clamp((p - delay - .08) / .55);
      if (t >= 1) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1 - t * t, 1 - t * t);
      ctx.fillStyle = '#102738';
      ctx.strokeStyle = t > .05 ? '#a2efff' : '#367a91';
      ctx.fill(hex);
      ctx.stroke(hex);
      ctx.restore();
    }
  };
}
