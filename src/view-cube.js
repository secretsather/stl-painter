import { Quaternion, Vector3 } from 'three';

// Model space is Z-up. Front looks along +Y and Right looks along -X.
const faces = {
  Front: new Vector3(0, -1, 0),
  Back: new Vector3(0, 1, 0),
  Right: new Vector3(1, 0, 0),
  Left: new Vector3(-1, 0, 0),
  Top: new Vector3(0, 0, 1),
  Bottom: new Vector3(0, 0, -1),
};
export const viewDirections = { Studio: new Vector3(1, -1.65, 0.89).normalize(), ...faces };

function svg(tag, attributes, parent) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  parent.append(node);
  return node;
}

export class ViewCube {
  constructor(root, onSelect) {
    this.inverse = new Quaternion();
    this.faces = Object.entries(faces).map(([name, normal]) => {
      const up = normal.z ? new Vector3(0, normal.z, 0) : new Vector3(0, 0, 1);
      const right = up.clone().cross(normal);
      const group = svg('g', { role: 'button', tabindex: 0, 'aria-label': name + ' view' }, root);
      svg('title', {}, group).textContent = name + ' view';
      svg('rect', { x: -25, y: -25, width: 50, height: 50 }, group);
      svg('text', { y: 4 }, group).textContent = name;
      group.onclick = () => onSelect(name);
      group.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onSelect(name);
        }
      };
      return { name, normal, right, down: up.negate(), group };
    });
    this.axes = ['X', 'Y', 'Z'].map((label, axis) => {
      const group = svg('g', { class: 'cube-axis axis-' + label, 'aria-hidden': true }, root);
      const line = svg('line', {}, group);
      const text = svg('text', {}, group);
      text.textContent = label;
      return { axis, group, line, text };
    });
  }

  update(camera) {
    this.inverse.copy(camera.quaternion).invert();
    const project = (point) => point.clone().applyQuaternion(this.inverse);
    const eye = new Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
    let view = eye.dot(viewDirections.Studio) > 1 - 1e-10 ? 'Studio' : 'Custom';
    for (const { name, normal, right, down, group } of this.faces) {
      const center = project(normal);
      const visible = center.z > 1e-5;
      group.style.display = visible ? '' : 'none';
      const aligned = center.z > 1 - 1e-10;
      if (aligned) view = name;
      group.setAttribute('aria-pressed', String(aligned));
      if (!visible) continue;
      const u = project(right),
        v = project(down);
      group.setAttribute(
        'transform',
        `matrix(${u.x} ${-u.y} ${v.x} ${-v.y} ${25 * center.x} ${-25 * center.y})`
      );
    }
    // A colored edge is visible when either of its two adjoining faces is visible.
    const corner = new Vector3(-1, -1, -1);
    const start = project(corner);
    for (const { axis, group, line, text } of this.axes) {
      const visible =
        eye.getComponent((axis + 1) % 3) < -1e-5 || eye.getComponent((axis + 2) % 3) < -1e-5;
      const end = project(corner.clone().setComponent(axis, 1));
      group.style.display =
        visible && Math.hypot(end.x - start.x, end.y - start.y) > 0.3 ? '' : 'none';
      line.setAttribute('x1', 25 * start.x);
      line.setAttribute('y1', -25 * start.y);
      line.setAttribute('x2', 25 * end.x);
      line.setAttribute('y2', -25 * end.y);
      const label = project(corner.clone().setComponent(axis, 1.45));
      text.setAttribute('x', 25 * label.x);
      text.setAttribute('y', -25 * label.y + 3);
    }
    return view;
  }
}
