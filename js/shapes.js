// Geometry shared by the on-screen renderer (SVG) and the PDF exporter (pdf-lib drawSvgPath).
// All coordinates are page-space points with a top-left origin.

const f = (n) => (Math.round(n * 100) / 100).toString();
const K = 0.5522847498;

export function pathD(points) {
  if (!points.length) return '';
  const [x0, y0] = points[0];
  if (points.length === 1) return `M${f(x0)} ${f(y0)} L${f(x0 + 0.01)} ${f(y0)}`;
  if (points.length === 2) return `M${f(x0)} ${f(y0)} L${f(points[1][0])} ${f(points[1][1])}`;
  let d = `M${f(x0)} ${f(y0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += ` Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d} L${f(lx)} ${f(ly)}`;
}

export function ellipseD(x, y, w, h) {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  return [
    `M${f(cx + rx)} ${f(cy)}`,
    `C${f(cx + rx)} ${f(cy + K * ry)} ${f(cx + K * rx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}`,
    `C${f(cx - K * rx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + K * ry)} ${f(cx - rx)} ${f(cy)}`,
    `C${f(cx - rx)} ${f(cy - K * ry)} ${f(cx - K * rx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}`,
    `C${f(cx + K * rx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - K * ry)} ${f(cx + rx)} ${f(cy)}`,
    'Z',
  ].join(' ');
}

// Returns drawable parts: { d, stroke, fill, width, cap, join }.
export function shapeParts(o) {
  switch (o.type) {
    case 'path':
      return [{ d: pathD(o.points), stroke: o.color, width: o.width, cap: 'round', join: 'round' }];
    case 'line':
      return [{ d: `M${f(o.x1)} ${f(o.y1)} L${f(o.x2)} ${f(o.y2)}`, stroke: o.color, width: o.width, cap: 'round', join: 'round' }];
    case 'arrow': {
      const dx = o.x2 - o.x1;
      const dy = o.y2 - o.y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const head = Math.min(len * 0.6, Math.max(10, o.width * 4));
      const half = head * 0.5;
      const bx = o.x2 - ux * head;
      const by = o.y2 - uy * head;
      const sx = o.x2 - ux * head * 0.8;
      const sy = o.y2 - uy * head * 0.8;
      return [
        { d: `M${f(o.x1)} ${f(o.y1)} L${f(sx)} ${f(sy)}`, stroke: o.color, width: o.width, cap: 'round', join: 'round' },
        {
          d: `M${f(o.x2)} ${f(o.y2)} L${f(bx - uy * half)} ${f(by + ux * half)} L${f(bx + uy * half)} ${f(by - ux * half)} Z`,
          fill: o.color,
          stroke: o.color,
          width: Math.max(1, o.width * 0.5),
          join: 'round',
        },
      ];
    }
    case 'rect':
      return [
        {
          d: `M${f(o.x)} ${f(o.y)} H${f(o.x + o.w)} V${f(o.y + o.h)} H${f(o.x)} Z`,
          stroke: o.stroke,
          fill: o.fill,
          width: o.stroke ? o.width : 0,
          join: 'miter',
          cap: 'butt',
        },
      ];
    case 'ellipse':
      return [{ d: ellipseD(o.x, o.y, o.w, o.h), stroke: o.stroke, fill: o.fill, width: o.stroke ? o.width : 0, join: 'round' }];
    default:
      return [];
  }
}

export const isVector = (o) => ['path', 'line', 'arrow', 'rect', 'ellipse'].includes(o.type);

// Geometric bounds (no stroke padding). Text bounds need a DOM measurement passed in.
export function geomBounds(o, measured) {
  switch (o.type) {
    case 'path': {
      const xs = o.points.map((p) => p[0]);
      const ys = o.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case 'line':
    case 'arrow': {
      const x = Math.min(o.x1, o.x2);
      const y = Math.min(o.y1, o.y2);
      return { x, y, w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
    }
    case 'text':
      return { x: o.x, y: o.y, w: measured?.w ?? 40, h: measured?.h ?? o.fontSize * 1.2 };
    default:
      return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
}

export function translateObj(o, dx, dy) {
  switch (o.type) {
    case 'path':
      o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
      break;
    case 'line':
    case 'arrow':
      o.x1 += dx;
      o.x2 += dx;
      o.y1 += dy;
      o.y2 += dy;
      break;
    default:
      o.x += dx;
      o.y += dy;
  }
}

// Maps an object from bounds `from` to bounds `to` (o should be a fresh copy of the original).
export function scaleObj(o, from, to) {
  const sx = from.w > 0.5 ? to.w / from.w : 1;
  const sy = from.h > 0.5 ? to.h / from.h : 1;
  const mx = (x) => to.x + (x - from.x) * sx;
  const my = (y) => to.y + (y - from.y) * sy;
  switch (o.type) {
    case 'path':
      o.points = o.points.map(([x, y]) => [mx(x), my(y)]);
      break;
    case 'line':
    case 'arrow':
      o.x1 = mx(o.x1);
      o.x2 = mx(o.x2);
      o.y1 = my(o.y1);
      o.y2 = my(o.y2);
      break;
    case 'text':
      o.fontSize = Math.max(4, Math.round(o.fontSize * sx * 10) / 10);
      o.x = to.x;
      o.y = to.y;
      break;
    default:
      o.x = to.x;
      o.y = to.y;
      o.w = Math.max(2, to.w);
      o.h = Math.max(2, to.h);
  }
}

// Ramer–Douglas–Peucker simplification for freehand strokes.
export function simplify(points, tolerance = 0.4) {
  if (points.length < 3) return points;
  const sq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let idx = -1;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > sq && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
