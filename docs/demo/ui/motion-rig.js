// Motion Studio's 3D side: the rigged model on a metric floor, pickable bones, the transform gizmo, two-bone IK,
// pose tools, onion skins, and the evaluation of a motion document into a pose (also used to bake).
// The page around it (toolbar, timeline, saving) lives in motion.js. three.js comes from the import map.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

export const CHANNELS = { r: { prop: "quaternion", size: 4 }, t: { prop: "position", size: 3 }, s: { prop: "scale", size: 3 } };

// ---------- keys: finding the segment, easing the time, interpolating the value ----------

// How far through a segment the value is at time x (0..1). The two ease handles are a CSS-like cubic bezier,
// (eo, 0) and (1 - ei, 1): both at 0 is even speed, larger values start or end more slowly.
export function easeTime(x, eo, ei) {
  if (!eo && !ei) return x;
  const x2 = 1 - ei;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 24; i += 1) {
    const bx = 3 * (1 - t) * (1 - t) * t * eo + 3 * (1 - t) * t * t * x2 + t * t * t;
    if (Math.abs(bx - x) < 1e-5) break;
    if (bx < x) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return 3 * (1 - t) * t * t + t * t * t;
}

function segment(keys, f) {
  let lo = 0, hi = keys.length - 1;
  if (f < keys[0].f) return -1;
  if (f >= keys[hi].f) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid].f <= f) lo = mid; else hi = mid; }
  return lo;
}

const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _s1 = new THREE.Quaternion(), _s2 = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _l1 = new THREE.Vector3(), _l2 = new THREE.Vector3();

function qlog(q, v) {
  const s = Math.hypot(q.x, q.y, q.z);
  return s < 1e-9 ? v.set(0, 0, 0) : v.set(q.x, q.y, q.z).multiplyScalar(Math.atan2(s, q.w) / s);
}
function qexp(v, q) {
  const a = v.length();
  if (a < 1e-9) return q.set(0, 0, 0, 1);
  const s = Math.sin(a) / a;
  return q.set(v.x * s, v.y * s, v.z * s, Math.cos(a));
}
// `v` as a quaternion on the same side of the sphere as `ref`, so neighbours never take the long way round.
function aligned(v, target, ref) {
  target.set(v[0], v[1], v[2], v[3]);
  if (ref && target.dot(ref) < 0) target.set(-v[0], -v[1], -v[2], -v[3]);
  return target;
}
// The inner control point of a squad spline at `cur`: what makes the rotation pass through keys without stopping.
function inner(prev, cur, next, out) {
  _qi.copy(cur).invert();
  qlog(_qa.copy(_qi).multiply(next), _l1);
  qlog(_qb.copy(_qi).multiply(prev), _l2);
  return out.copy(cur).multiply(qexp(_l1.add(_l2).multiplyScalar(-0.25), _qa));
}

// The value of a channel at frame f. keys: [{f, v, i: "smooth" | "linear" | "step", eo, ei}], sorted by f.
export function evalKeys(keys, f, size, out = []) {
  const i = segment(keys, f);
  const hold = i < 0 ? keys[0] : i >= keys.length - 1 ? keys[keys.length - 1] : keys[i].i === "step" ? keys[i] : null;
  if (hold) { for (let c = 0; c < size; c += 1) out[c] = hold.v[c]; return out; }
  const a = keys[i], b = keys[i + 1];
  const u = easeTime((f - a.f) / (b.f - a.f), a.eo || 0, b.ei || 0);
  if (size === 4) {
    aligned(a.v, _q1);
    aligned(b.v, _q2, _q1);
    if (a.i === "linear") _qa.slerpQuaternions(_q1, _q2, u);
    else {
      if (i > 0) inner(aligned(keys[i - 1].v, _q0, _q1), _q1, _q2, _s1); else _s1.copy(_q1);
      if (i + 2 < keys.length) inner(_q1, _q2, aligned(keys[i + 2].v, _q3, _q2), _s2); else _s2.copy(_q2);
      _qa.slerpQuaternions(_q1, _q2, u);
      _qb.slerpQuaternions(_s1, _s2, u);
      _qa.slerp(_qb, 2 * u * (1 - u));
    }
    out[0] = _qa.x; out[1] = _qa.y; out[2] = _qa.z; out[3] = _qa.w;
    return out;
  }
  const d = b.f - a.f, p0 = keys[i - 1], p3 = keys[i + 2];
  const u2 = u * u, u3 = u2 * u;
  for (let c = 0; c < size; c += 1) {
    if (a.i === "linear") { out[c] = a.v[c] + (b.v[c] - a.v[c]) * u; continue; }
    const m1 = p0 ? ((b.v[c] - p0.v[c]) / (b.f - p0.f)) * d : b.v[c] - a.v[c];
    const m2 = p3 ? ((p3.v[c] - a.v[c]) / (p3.f - a.f)) * d : b.v[c] - a.v[c];
    out[c] = (2 * u3 - 3 * u2 + 1) * a.v[c] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * b.v[c] + (u3 - u2) * m2;
  }
  return out;
}

// Put a value at frame f: replaces the key there, or adds one that takes its neighbour's interpolation.
export function upsertKey(keys, f, v) {
  const at = keys.findIndex((k) => k.f >= f);
  if (at >= 0 && keys[at].f === f) { keys[at].v = v; return keys[at]; }
  const near = keys[at < 0 ? keys.length - 1 : Math.max(0, at - 1)];
  const key = { f, v, i: near ? near.i : "smooth", eo: 0, ei: 0 };
  keys.splice(at < 0 ? keys.length : at, 0, key);
  return key;
}

// "LeftArm" <-> "RightArm", "arm_l" <-> "arm_r", "L_Hand" <-> "R_Hand"; null when the name has no side.
export function mirrorName(name) {
  const word = name.replace(/left|right/i, (m) => {
    const other = m.toLowerCase() === "left" ? "right" : "left";
    return m === m.toUpperCase() ? other.toUpperCase() : m[0] === m[0].toUpperCase() ? other[0].toUpperCase() + other.slice(1) : other;
  });
  if (word !== name) return word;
  const letter = name.replace(/(^|[^a-zA-Z])([LlRr])(?=$|[^a-zA-Z])/, (_m, pre, c) => pre + ({ L: "R", R: "L", l: "r", r: "l" })[c]);
  return letter !== name ? letter : null;
}

const FINGERS = /thumb|index|middle|ring|pinky|little|finger|toe/i;

function boneShape() {
  const w = 0.1, h = 0.2;
  const ring = [[w, h, w], [-w, h, w], [-w, h, -w], [w, h, -w]];
  const tris = [];
  for (let i = 0; i < 4; i += 1) tris.push([[0, 0, 0], ring[i], ring[(i + 1) % 4]], [[0, 1, 0], ring[(i + 1) % 4], ring[i]]);
  const centre = new THREE.Vector3(0, 0.4, 0), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const flat = [];
  for (const tri of tris) {
    a.fromArray(tri[0]); b.fromArray(tri[1]); c.fromArray(tri[2]);
    const normal = b.clone().sub(a).cross(c.clone().sub(a));
    const out = a.clone().add(b).add(c).divideScalar(3).sub(centre);
    flat.push(...(normal.dot(out) < 0 ? [tri[0], tri[2], tri[1]] : tri).flat());  // every face looks outward
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// The studio viewport for one rigged GLB. `scale` turns the model's units into metres (from the asset's height).
export async function createRig(container, url, { scale = 1 } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the model (${res.status}).`);
  const buffer = await res.arrayBuffer();
  if (new TextDecoder("latin1").decode(new Uint8Array(buffer, 0, 4)) !== "glTF") throw new Error("Motion Studio opens .glb rigs. This file is another format saved under a .glb name.");
  const clean = url.split("?")[0];
  const gltf = await new GLTFLoader().parseAsync(buffer, clean.slice(0, clean.lastIndexOf("/") + 1));
  const object = gltf.scene;
  const nodeNames = (gltf.parser.json.nodes || []).map((n, i) => n.name || `node_${i}`);
  const taken = new Set();
  const bones = [];
  const byKey = new Map();
  const byObject = new Map();
  object.traverse((o) => {
    if (o.isSkinnedMesh) o.frustumCulled = false;
    if (!o.isBone) return;
    const node = gltf.parser.associations.get(o)?.nodes;
    let key = Number.isInteger(node) ? nodeNames[node] : o.name;
    if (taken.has(key)) key = `${key}#${node ?? bones.length}`;
    taken.add(key);
    const parent = byObject.get(o.parent);
    const entry = { key, name: key, node: Number.isInteger(node) ? node : null, bone: o, parent: parent ? parent.key : "", depth: parent ? parent.depth + 1 : 0,
      rest: { t: o.position.clone(), r: o.quaternion.clone(), s: o.scale.clone() } };
    bones.push(entry);
    byKey.set(key, entry);
    byObject.set(o, entry);
  });
  if (!bones.length) throw new Error("This model has no skeleton yet. Rig it on its asset page, then open it here.");

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  const rimLight = new THREE.DirectionalLight(0xc9d4ff, 0.7);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x26262c, 0.4), keyLight, rimLight);

  const holder = new THREE.Group();
  holder.scale.setScalar(scale);
  holder.add(object);
  scene.add(holder);
  holder.updateMatrixWorld(true);
  for (const b of bones) {
    b.restWorldQ = b.bone.getWorldQuaternion(new THREE.Quaternion());
    b.restWorldP = b.bone.getWorldPosition(new THREE.Vector3());
    b.parentRestWorldQ = b.bone.parent.getWorldQuaternion(new THREE.Quaternion());
  }
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z) || 1;

  // The floor: a line every metre, and a fainter one every 10 cm.
  const extent = Math.max(10, Math.ceil(span * 4));
  const fine = new THREE.GridHelper(extent, extent * 10, 0x1d1d24, 0x1d1d24);
  const metres = new THREE.GridHelper(extent, extent, 0x55556a, 0x34343f);
  fine.position.y = box.min.y - 0.0005;
  metres.position.y = box.min.y;
  scene.add(fine, metres);

  const camera = new THREE.PerspectiveCamera(35, 1, span / 200, span * 200);
  camera.position.set(centre.x + span * 1.5, centre.y + span * 0.35, centre.z + span * 2.4);
  keyLight.position.set(span * 1.2, span * 2.2, span * 1.5);
  rimLight.position.set(-span * 1.6, span * 1.2, -span * 1.6);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.copy(centre);
  orbit.enableDamping = true;

  // ---------- bones you can see and click ----------
  const overlay = new THREE.Group();
  scene.add(overlay);
  const look = (color, opacity = 0.92) => new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, flatShading: true, transparent: true, opacity, depthTest: false, depthWrite: false });
  const mats = { bone: look(0x8c96ff, 0.85), joint: look(0xe6e9ff), picked: look(0xffb020, 1), ik: look(0x3dd6c6, 1), ikPicked: look(0xffb020, 1), pinned: look(0xff5d73, 1) };
  const shape = boneShape();
  const ball = new THREE.SphereGeometry(1, 14, 10);
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const jointSize = span * 0.011;
  const links = [];
  const pickables = [];
  for (const b of bones) {
    const kids = bones.filter((c) => c.parent === b.key);
    for (const kid of kids.length ? kids : [null]) {
      const mesh = new THREE.Mesh(shape, mats.bone);
      mesh.renderOrder = 20;
      mesh.userData.pick = { type: "bone", key: b.key };
      overlay.add(mesh);
      pickables.push(mesh);
      links.push({ mesh, from: b, to: kid });
    }
    b.joint = new THREE.Mesh(ball, mats.joint);
    b.joint.scale.setScalar(jointSize);
    b.joint.renderOrder = 21;
    b.joint.userData.pick = { type: "bone", key: b.key };
    overlay.add(b.joint);
    pickables.push(b.joint);
  }
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  const wp = (b, out) => out.setFromMatrixPosition(b.bone.matrixWorld);
  function placeBones() {
    for (const b of bones) wp(b, b.joint.position);
    for (const link of links) {
      wp(link.from, _a);
      if (link.to) wp(link.to, _b);
      else {  // a leaf bone carries on a little way in the direction it arrived from
        const parent = byKey.get(link.from.parent);
        if (parent) _b.copy(_a).sub(wp(parent, _c)).multiplyScalar(0.4).add(_a); else _b.copy(_a).addScaledVector(_up, span * 0.05);
      }
      const length = _b.sub(_a).length();
      link.mesh.visible = length > 1e-6;
      if (!link.mesh.visible) continue;
      link.mesh.position.copy(_a);
      link.mesh.quaternion.setFromUnitVectors(_up, _b.divideScalar(length));
      const width = Math.min(length, span * 0.22);
      link.mesh.scale.set(width, length, width);
    }
    for (const h of handles.values()) {
      wp(byKey.get(h.chain.tip), h.mesh.position);
      h.mesh.quaternion.copy(camera.quaternion);
    }
  }

  // ---------- the motion document and how it becomes a pose ----------
  let doc = null;
  let frame = 0;
  let active = 0;       // index of the layer new keys go to
  let base = null;      // the source clip under the layers: [{ target, prop, interpolant }], with .duration
  const scratch = new Map();  // key -> { r?, t?, s? }: poses not keyed yet; they last until the frame changes
  const handlers = { select() {}, edit() {}, scratch() {} };
  const _v = [];
  const _qd = new THREE.Quaternion(), _ident = new THREE.Quaternion();

  function setDoc(next) {
    doc = next;
    base = null;
    const clip = Number.isInteger(doc.base_clip) ? gltf.animations[doc.base_clip] : null;
    if (clip) {
      base = [];
      base.duration = clip.duration;
      for (const track of clip.tracks) {
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        const target = THREE.PropertyBinding.findNode(object, parsed.nodeName);
        if (target && ["position", "quaternion", "scale"].includes(parsed.propertyName)) base.push({ target, prop: parsed.propertyName, interpolant: track.createInterpolant() });
      }
    }
    active = Math.min(active, doc.layers.length - 1);
    rev += 1;
    scratch.clear();
    refreshHandles();
  }

  function sampleBase(seconds) {
    const t = seconds > base.duration ? (doc.loop ? seconds % base.duration : base.duration) : seconds;
    for (const track of base) track.target[track.prop].fromArray(track.interpolant.evaluate(t));
  }

  function applyLayer(layer, f) {
    const w = layer.weight;
    for (const key in layer.tracks) {
      const b = byKey.get(key);
      if (!b) continue;
      const track = layer.tracks[key];
      if (track.r?.length) {
        evalKeys(track.r, f, 4, _v);
        _qd.set(_v[0], _v[1], _v[2], _v[3]);
        if (layer.mode === "additive") b.bone.quaternion.multiply(w < 1 ? _qd.copy(_ident).slerp(_qa.set(_v[0], _v[1], _v[2], _v[3]), w) : _qd);
        else b.bone.quaternion.slerp(_qd, w);
      }
      if (track.t?.length) {
        evalKeys(track.t, f, 3, _v);
        if (layer.mode === "additive") b.bone.position.addScaledVector(_a.set(_v[0], _v[1], _v[2]), w);
        else b.bone.position.lerp(_a.set(_v[0], _v[1], _v[2]), w);
      }
      if (track.s?.length) {
        evalKeys(track.s, f, 3, _v);
        if (layer.mode === "additive") b.bone.scale.multiply(_a.set(1 + (_v[0] - 1) * w, 1 + (_v[1] - 1) * w, 1 + (_v[2] - 1) * w));
        else b.bone.scale.lerp(_a.set(_v[0], _v[1], _v[2]), w);
      }
    }
  }

  function applyUnkeyed() {
    for (const [key, pose] of scratch) {
      const bone = byKey.get(key).bone;
      if (pose.r) bone.quaternion.fromArray(pose.r);
      if (pose.t) bone.position.fromArray(pose.t);
      if (pose.s) bone.scale.fromArray(pose.s);
    }
  }

  // The keyed pose at frame f: bind pose, then the source clip, then each layer.
  function stage(f, upto) {
    for (const b of bones) { b.bone.position.copy(b.rest.t); b.bone.quaternion.copy(b.rest.r); b.bone.scale.copy(b.rest.s); }
    if (base) sampleBase(f / doc.fps);
    for (let i = 0; i < doc.layers.length && i < upto; i += 1) if (!doc.layers[i].mute && doc.layers[i].weight > 0) applyLayer(doc.layers[i], f);
  }

  // ---------- modifiers: procedural changes on top of the keys, never written into them ----------
  const SETS = { legs: /leg|thigh|shin|calf|knee|foot|ankle|toe/i, arms: /arm|shoulder|clavicle|elbow|hand|wrist|finger|thumb/i };
  const setCache = new Map();
  // The bones a modifier touches: "all", "legs", "arms", or "branch" (the bone `root` and everything below it).
  function boneSet(m) {
    const id = `${m.set || "all"}|${m.root || ""}`;
    if (!setCache.has(id)) {
      const inside = new Set();
      for (const b of bones) if (m.set === "branch" ? b.key === m.root || inside.has(b.parent) : !SETS[m.set] || SETS[m.set].test(b.key)) inside.add(b.key);
      setCache.set(id, inside);
    }
    return setCache.get(id);
  }
  const hash = (n, seed) => { let h = Math.imul(n ^ (seed * 374761393), 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1; };
  // Smooth noise in -1..1; with a period it repeats exactly, so a looping clip twitches without a seam.
  function noise(u, period, seed) {
    const i = Math.floor(u), t = u - i, s = t * t * (3 - 2 * t);
    const wrap = (n) => (period ? ((n % period) + period) % period : n);
    return hash(wrap(i), seed) * (1 - s) + hash(wrap(i + 1), seed) * s;
  }

  let rev = 0;           // goes up when the document changes; what is cached below depends on it
  let plantCache = null;
  const _fp = new THREE.Vector3(), _fq = new THREE.Quaternion(), _eul = new THREE.Euler();
  // Where the floor is and, when feet are locked, where each foot stays put on every frame it is down.
  function plants(m) {
    if (plantCache && plantCache.rev === rev) return plantCache;
    const chains = doc.ik.chains.filter((c) => /foot|ankle/i.test(c.tip) && handles.has(c.name));
    const floor = chains.length ? Math.min(...chains.map((c) => byKey.get(c.tip).restWorldP.y)) : 0;
    const cache = plantCache = { rev, floor, chains, lock: new Map() };  // set before the evaluations below, which come back through here
    if (m.lock && chains.length) {
      const seen = chains.map(() => []);
      for (let f = 0; f <= doc.frames; f += 1) {
        evalPose(f, { unkeyed: false, clamp: false });
        holder.updateMatrixWorld(true);
        chains.forEach((c, i) => seen[i].push(wp(byKey.get(c.tip), new THREE.Vector3())));
      }
      chains.forEach((c, i) => {
        let hold = null;
        cache.lock.set(c.name, seen[i].map((p) => (hold = p.y <= floor + span * 0.015 ? hold || [p.x, p.z] : null)));
      });
    }
    return cache;
  }

  // Pose the skeleton for frame f: the keyed pose (each bone at the time its time modifiers give it), unkeyed
  // edits, then the modifiers that bend the pose, then the floor.
  function evalPose(f, { upto = Infinity, unkeyed = true, mods = true, clamp = true } = {}) {
    if (!doc) { for (const b of bones) { b.bone.position.copy(b.rest.t); b.bone.quaternion.copy(b.rest.r); b.bone.scale.copy(b.rest.s); } return; }
    const live = mods && upto === Infinity ? doc.modifiers.filter((m) => m.on !== false) : [];
    const floorMod = clamp ? live.find((m) => m.type === "clamp") : null;
    const table = floorMod ? plants(floorMod) : null;  // first: building it moves the skeleton
    const timed = live.filter((m) => m.type === "reverse" || m.type === "quantize" || (m.type === "stride" && m.speed && m.speed !== 1));
    if (!timed.length) stage(f, upto);
    else {
      const groups = new Map();
      bones.forEach((b, i) => {
        let g = f;
        for (const m of timed) {
          if (m.type !== "stride" && !boneSet(m).has(b.key)) continue;
          if (m.type === "reverse") g = doc.frames - g;
          else if (m.type === "quantize") g = Math.floor(g / Math.max(1, m.step || 2)) * Math.max(1, m.step || 2);
          else { g *= m.speed; g = doc.loop ? g % doc.frames : Math.min(g, doc.frames); }
        }
        (groups.get(g) || groups.set(g, []).get(g)).push(i);
      });
      const held = [];
      for (const [g, list] of groups) { stage(g, upto); for (const i of list) held[i] = local(bones[i]); }
      bones.forEach((b, i) => { b.bone.quaternion.fromArray(held[i].r); b.bone.position.fromArray(held[i].t); b.bone.scale.fromArray(held[i].s); });
    }
    if (unkeyed) applyUnkeyed();
    for (const m of live) {
      if (m.type === "stride" && m.stride !== undefined && m.stride !== 1) {  // longer or shorter steps: the legs swing more, the root travels further
        for (const b of bones) {
          if (SETS.legs.test(b.key)) b.bone.quaternion.copy(_qd.copy(b.rest.r).slerp(b.bone.quaternion, m.stride)).normalize();
          if (!b.parent) { b.bone.position.x = b.rest.t.x + (b.bone.position.x - b.rest.t.x) * m.stride; b.bone.position.z = b.rest.t.z + (b.bone.position.z - b.rest.t.z) * m.stride; }
        }
      } else if (m.type === "twitch") {
        const rate = m.speed || 8, set = boneSet(m), amount = THREE.MathUtils.degToRad(m.amount ?? 12);
        const period = doc.loop ? Math.max(1, Math.round((doc.frames / doc.fps) * rate)) : 0;
        const u = period ? (f / doc.frames) * period : (f / doc.fps) * rate;
        const n = (seed) => noise(u, period, seed) * 0.7 + noise(u * 2, period * 2, seed + 3) * 0.3;
        bones.forEach((b, i) => {
          if (!set.has(b.key)) return;
          const seed = (m.seed || 1) * 131 + i * 17;
          b.bone.quaternion.multiply(_qd.setFromEuler(_eul.set(n(seed) * amount, n(seed + 5) * amount, n(seed + 11) * amount)));
        });
      }
    }
    if (table) {
      holder.updateMatrixWorld(true);
      for (const chain of table.chains) {
        const tip = byKey.get(chain.tip);
        wp(tip, _fp);
        const lock = table.lock.get(chain.name)?.[Math.round(f)];
        const sunk = _fp.y < table.floor;
        if (!lock && !sunk) continue;
        if (lock) { _fp.x = lock[0]; _fp.z = lock[1]; }
        if (sunk) _fp.y = table.floor;
        solveChain(chain, _fp, tip.bone.getWorldQuaternion(_fq));
      }
    }
  }

  const local = (b) => ({ r: b.bone.quaternion.toArray(), t: b.bone.position.toArray(), s: b.bone.scale.toArray() });
  const near = (x, y, eps = 1e-5) => x.every((v, i) => Math.abs(v - y[i]) < eps);
  const sameRotation = (x, y) => Math.abs(x[0] * y[0] + x[1] * y[1] + x[2] * y[2] + x[3] * y[3]) > 1 - 1e-7;

  function note(key, channel) {
    const b = byKey.get(key);
    const pose = scratch.get(key) || {};
    pose[channel] = b.bone[CHANNELS[channel].prop].toArray();
    scratch.set(key, pose);
  }

  // Which channels pressing I keys on a bone: rotation always; position and scale when they are in play.
  function keyChannels(key) {
    const b = byKey.get(key), pose = scratch.get(key) || {}, track = doc.layers[active].tracks[key] || {};
    const out = ["r"];
    if (pose.t || track.t || !b.parent) out.push("t");
    if (pose.s || track.s) out.push("s");
    return out;
  }

  // Record the pose on screen as keys on the active layer, at the current frame. list: [[boneKey, ["r", "t"]], …].
  function keyBones(list) {
    const f = Math.round(frame);
    const layer = doc.layers[active];
    evalPose(f, { mods: false });
    const finals = list.filter(([key]) => byKey.has(key)).map(([key, channels]) => [key, channels, local(byKey.get(key))]);
    let below = null;
    if (layer.mode === "additive") {
      evalPose(f, { upto: active, unkeyed: false });
      below = new Map(finals.map(([key]) => [key, local(byKey.get(key))]));
    }
    for (const [key, channels, now] of finals) {
      const track = (layer.tracks[key] ||= {});
      for (const ch of channels) {
        let value = now[ch];
        if (below) {
          const under = below.get(key)[ch];
          if (ch === "r") value = _qa.fromArray(under).invert().multiply(_qb.fromArray(now.r)).toArray();
          else if (ch === "t") value = now.t.map((v, i) => v - under[i]);
          else value = now.s.map((v, i) => (Math.abs(under[i]) > 1e-9 ? v / under[i] : 1));
        }
        upsertKey((track[ch] ||= []), f, value.map((v) => Math.round(v * 1e6) / 1e6));
      }
      const pose = scratch.get(key);
      if (pose) { channels.forEach((ch) => delete pose[ch]); if (!Object.keys(pose).length) scratch.delete(key); }
    }
    evalPose(f);
    handlers.scratch(scratch.size);
  }

  // ---------- selection and the gizmo ----------
  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.8);
  const gizmoHelper = gizmo.getHelper();
  scene.add(gizmoHelper);
  const proxy = new THREE.Object3D();  // what the gizmo holds while an IK handle is selected
  scene.add(proxy);
  let selection = null;  // { type: "bone", key } | { type: "ik", name }
  let mode = "rotate";
  let space = "local";
  let dragging = false;
  const pending = new Map();  // key -> Set of channels changed by the drag under way
  const touch = (key, ch) => { note(key, ch); (pending.get(key) || pending.set(key, new Set()).get(key)).add(ch); };
  const tipQ = new THREE.Quaternion();

  function paint() {
    for (const link of links) link.mesh.material = selection?.type === "bone" && selection.key === link.from.key ? mats.picked : mats.bone;
    for (const b of bones) b.joint.material = selection?.type === "bone" && selection.key === b.key ? mats.picked : mats.joint;
    for (const h of handles.values()) h.mesh.material = selection?.type === "ik" && selection.name === h.chain.name ? mats.ikPicked : pins.has(h.chain.name) ? mats.pinned : mats.ik;
  }

  function select(next, quiet = false) {
    selection = next && (next.type === "bone" ? byKey.has(next.key) : handles.has(next.name)) ? next : null;
    gizmo.detach();
    if (selection?.type === "bone") {
      gizmo.attach(byKey.get(selection.key).bone);
      gizmo.setMode(mode);
      gizmo.setSpace(space);
    } else if (selection) {
      wp(byKey.get(handles.get(selection.name).chain.tip), proxy.position);
      gizmo.attach(proxy);
      gizmo.setMode("translate");
      gizmo.setSpace("world");
    }
    paint();
    if (!quiet) handlers.select(selection);
  }

  gizmo.addEventListener("dragging-changed", (e) => {
    dragging = e.value;
    orbit.enabled = !e.value;
    if (e.value) {
      pending.clear();
      if (selection?.type === "ik") byKey.get(handles.get(selection.name).chain.tip).bone.getWorldQuaternion(tipQ);
    } else if (pending.size) {
      handlers.edit([...pending].map(([key, set]) => [key, [...set]]));
      pending.clear();
    }
  });
  gizmo.addEventListener("objectChange", () => {
    if (!selection) return;
    if (selection.type === "ik") {
      const chain = handles.get(selection.name).chain;
      solveChain(chain, proxy.position, tipQ);
      [chain.root, chain.mid, chain.tip].forEach((key) => touch(key, "r"));
      holdPins(chain.name);
    } else {
      touch(selection.key, { rotate: "r", translate: "t", scale: "s" }[gizmo.getMode()]);
      holdPins("");
    }
    handlers.scratch(scratch.size);
  });

  const raycaster = new THREE.Raycaster();
  let down = null;
  const onDown = (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; };
  const onUp = (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || gizmo.axis || dragging) { down = null; return; }
    down = null;
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
    const hits = overlay.visible ? raycaster.intersectObjects(pickables.filter((p) => p.visible), false) : [];
    // IK handles and joints sit inside the bone shapes, so they win when the click lands on both.
    const hit = hits.find((h) => h.object.userData.pick.type === "ik") || hits.find((h) => h.object.geometry === ball) || hits[0];
    select(hit ? hit.object.userData.pick : null);
  };
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);

  // ---------- two-bone IK ----------
  const handles = new Map();  // chain name -> { chain, mesh }
  const pins = new Map();     // chain name -> { target, tipQ }: the tip stays there while other bones are moved
  const _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _turn = new THREE.Quaternion();

  function refreshHandles() {
    for (const h of handles.values()) { overlay.remove(h.mesh); pickables.splice(pickables.indexOf(h.mesh), 1); }
    handles.clear();
    for (const chain of doc?.ik.chains || []) {
      if (![chain.root, chain.mid, chain.tip].every((k) => byKey.has(k)) || handles.has(chain.name)) continue;
      const mesh = new THREE.Mesh(cube, mats.ik);
      mesh.scale.setScalar(jointSize * 2.6);
      mesh.renderOrder = 22;
      mesh.userData.pick = { type: "ik", name: chain.name };
      overlay.add(mesh);
      pickables.push(mesh);
      handles.set(chain.name, { chain, mesh });
    }
    for (const name of [...pins.keys()]) if (!handles.has(name)) pins.delete(name);
    if (selection?.type === "ik" && !handles.has(selection.name)) select(null);
    paint();
  }

  // Turn `bone` (around its own joint) so the point now at `cur` lands on `want`.
  function swing(bone, from, cur, want) {
    _turn.setFromUnitVectors(_c.copy(cur).sub(from).normalize(), _d.copy(want).sub(from).normalize());
    bone.getWorldQuaternion(_wq);
    bone.parent.getWorldQuaternion(_pq);
    bone.quaternion.copy(_pq.invert().multiply(_turn.multiply(_wq)));
    bone.updateWorldMatrix(false, true);
  }

  // The way this joint bends by nature (a knee forward, an elbow back), carried along with the limb's parent.
  function naturalBend(chain, dir, out) {
    const A = byKey.get(chain.root), B = byKey.get(chain.mid), C = byKey.get(chain.tip);
    const limb = _c.copy(C.restWorldP).sub(A.restWorldP);
    const reach = limb.length() || 1;
    out.copy(B.restWorldP).sub(A.restWorldP).addScaledVector(limb, -out.dot(limb) / (reach * reach));
    if (out.length() < reach * 0.02) out.set(0, 0, Math.abs(limb.y) > Math.hypot(limb.x, limb.z) ? 1 : -1);  // dead straight in the bind pose
    A.bone.parent.getWorldQuaternion(_pq);
    out.applyQuaternion(_wq.copy(A.parentRestWorldQ).invert().premultiply(_pq));
    if (chain.flip) out.negate();
    out.addScaledVector(dir, -out.dot(dir));
    if (out.lengthSq() < 1e-10) out.set(dir.y, -dir.x, 0);
    return out.normalize();
  }

  const _pole = new THREE.Vector3(), _nat = new THREE.Vector3(), _dir = new THREE.Vector3(), _wa = new THREE.Vector3(), _wb = new THREE.Vector3(), _wc = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
  // Move the chain so its tip reaches `target` (world). With anatomical limits on, the middle joint only bends its
  // natural way; in horror mode it keeps bending whichever way it already does, so it can be dragged inside out
  // without snapping back. `keepTip` holds the tip bone's world rotation (a foot stays flat on the floor).
  function solveChain(chain, target, keepTip = null, invert = false) {
    const A = byKey.get(chain.root), B = byKey.get(chain.mid), C = byKey.get(chain.tip);
    holder.updateMatrixWorld(true);
    wp(A, _wa); wp(B, _wb); wp(C, _wc);
    const l1 = _wa.distanceTo(_wb), l2 = _wb.distanceTo(_wc);
    _dir.copy(target).sub(_wa);
    let d = _dir.length();
    if (d < 1e-7 || l1 < 1e-7 || l2 < 1e-7) return;
    _dir.divideScalar(d);
    d = Math.min((l1 + l2) * 0.9995, Math.max(Math.abs(l1 - l2) * 1.0005 + 1e-6, d));
    naturalBend(chain, _dir, _nat);
    _pole.copy(_wb).sub(_wa).addScaledVector(_dir, -_pole.dot(_dir));
    if (_pole.length() < l1 * 1e-3) _pole.copy(_nat);
    else {
      _pole.normalize();
      if (invert) _pole.negate();
      else if (!doc.ik.horror && _pole.dot(_nat) < 0) _pole.copy(_nat);
    }
    const cos = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
    _t1.copy(_wa).addScaledVector(_dir, l1 * cos).addScaledVector(_pole, l1 * Math.sqrt(1 - cos * cos));
    _t2.copy(_wa).addScaledVector(_dir, d);
    swing(A.bone, _wa, _wb, _t1);
    wp(B, _wb); wp(C, _wc);
    swing(B.bone, _wb, _wc, _t2);
    if (keepTip) {
      B.bone.getWorldQuaternion(_pq);
      C.bone.quaternion.copy(_pq.invert().multiply(_wq.copy(keepTip)));
      C.bone.updateWorldMatrix(false, true);
    }
  }

  function holdPins(except) {
    for (const [name, pin] of pins) {
      if (name === except || !handles.has(name)) continue;
      const chain = handles.get(name).chain;
      solveChain(chain, pin.target, pin.tipQ);
      [chain.root, chain.mid, chain.tip].forEach((key) => touch(key, "r"));
    }
  }

  const chainName = (tip) => tip.key.replace(/^.*[:|]/, "");
  // Arms, legs, tails and the head, found by bone name: the tip, its parent and its grandparent.
  function autoChains() {
    const found = [];
    for (const b of bones) {
      const low = b.key.toLowerCase();
      const limb = (/hand|wrist|foot|ankle/.test(low) && !FINGERS.test(low)) || (/head$/.test(low.replace(/[^a-z]/g, "")) && !/top|end/.test(low));
      const tail = /tail/.test(low) && !bones.some((c) => c.parent === b.key && /tail/i.test(c.key));
      const mid = byKey.get(b.parent), root = mid && byKey.get(mid.parent);
      if ((limb || tail) && root) found.push({ name: chainName(b), root: root.key, mid: mid.key, tip: b.key, flip: false });
    }
    return found;
  }
  function addChain(tipKey) {
    const tip = byKey.get(tipKey), mid = tip && byKey.get(tip.parent), root = mid && byKey.get(mid.parent);
    if (!root) return null;
    const chain = { name: chainName(tip), root: root.key, mid: mid.key, tip: tip.key, flip: false };
    doc.ik.chains = doc.ik.chains.filter((c) => c.name !== chain.name).concat(chain);
    refreshHandles();
    return chain;
  }

  // ---------- pose tools ----------
  const copyPose = () => Object.fromEntries(bones.map((b) => [b.key, local(b)]));
  const restPose = () => Object.fromEntries(bones.map((b) => [b.key, { r: b.rest.r.toArray(), t: b.rest.t.toArray(), s: b.rest.s.toArray() }]));

  // Put a whole pose on the skeleton as unkeyed edits. Returns what changed: [[boneKey, [channels]], …].
  function applyPose(pose) {
    evalPose(Math.round(frame), { mods: false });
    const changed = [];
    for (const key in pose) {
      const b = byKey.get(key);
      if (!b) continue;
      const now = local(b), channels = [];
      if (pose[key].r && !sameRotation(pose[key].r, now.r)) channels.push("r");
      if (pose[key].t && !near(pose[key].t, now.t)) channels.push("t");
      if (pose[key].s && !near(pose[key].s, now.s)) channels.push("s");
      if (!channels.length) continue;
      const held = scratch.get(key) || {};
      channels.forEach((ch) => { held[ch] = [...pose[key][ch]]; });
      scratch.set(key, held);
      changed.push([key, channels]);
    }
    handlers.scratch(scratch.size);
    return changed;
  }

  // The pose with left and right swapped. Each bone's turn away from its bind pose is reflected through the
  // model's middle plane and given to its partner, so it works whatever way the rig's bone axes point.
  function mirroredPose() {
    evalPose(Math.round(frame), { mods: false });
    holder.updateMatrixWorld(true);
    const worldQ = new Map(bones.map((b) => [b.key, b.bone.getWorldQuaternion(new THREE.Quaternion())]));
    const worldP = new Map(bones.map((b) => [b.key, b.bone.getWorldPosition(new THREE.Vector3())]));
    const fresh = new Map();
    const pose = {};
    for (const b of bones) {  // parents come first in this list
      const other = byKey.get(mirrorName(b.key) || "") || b;
      const delta = worldQ.get(other.key).clone().multiply(other.restWorldQ.clone().invert());
      const world = new THREE.Quaternion(delta.x, -delta.y, -delta.z, delta.w).multiply(b.restWorldQ);
      fresh.set(b.key, world);
      const parentQ = fresh.get(b.parent) || b.bone.parent.getWorldQuaternion(new THREE.Quaternion());
      pose[b.key] = { r: parentQ.clone().invert().multiply(world).toArray() };
      if (!b.parent && !near(b.bone.position.toArray(), b.rest.t.toArray())) {  // the root's travel is mirrored too
        const moved = worldP.get(other.key).clone().sub(other.restWorldP);
        moved.x = -moved.x;
        pose[b.key].t = b.bone.parent.worldToLocal(moved.add(b.restWorldP)).toArray();
      }
    }
    return pose;
  }

  // ---------- onion skins: the two frames before (blue) and after (amber) ----------
  let ghosts = null;
  let onion = false;
  function makeGhosts() {
    ghosts = [-2, -1, 1, 2].map((offset) => {
      const root = SkeletonUtils.clone(object);
      const material = new THREE.MeshBasicMaterial({ color: offset < 0 ? 0x5aa9ff : 0xffb454, transparent: true, opacity: Math.abs(offset) === 1 ? 0.22 : 0.11, depthWrite: false });
      const list = [];
      root.traverse((o) => { if (o.isMesh) { o.material = material; o.frustumCulled = false; o.renderOrder = 5; } if (o.isBone) list.push(o); });
      holder.add(root);
      return { offset, root, bones: list };
    });
  }
  function poseGhosts() {
    for (const g of ghosts) {
      let f = Math.round(frame) + g.offset;
      if (doc.loop) f = ((f % doc.frames) + doc.frames) % doc.frames;
      g.root.visible = f >= 0 && f <= doc.frames;
      if (!g.root.visible) continue;
      evalPose(f, { unkeyed: false });
      g.bones.forEach((bone, i) => { bone.position.copy(bones[i].bone.position); bone.quaternion.copy(bones[i].bone.quaternion); bone.scale.copy(bones[i].bone.scale); });
    }
  }

  // ---------- the loop ----------
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  let running = true;
  const clock = new THREE.Clock();
  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    api.onTick?.(Math.min(clock.getDelta(), 0.1));
    if (doc) {
      if (onion && ghosts) poseGhosts();
      evalPose(frame);
    }
    holder.updateMatrixWorld(true);
    if (selection?.type === "ik" && !dragging) wp(byKey.get(handles.get(selection.name).chain.tip), proxy.position);
    placeBones();
    orbit.update();
    renderer.render(scene, camera);
    // Between frames the bones hold the keyed pose, so the gizmo and the pose tools edit keys, not a modifier's output.
    if (doc && doc.modifiers.some((m) => m.on !== false)) evalPose(frame, { mods: false });
  }
  requestAnimationFrame(loop);

  const api = {
    bones: bones.map((b) => ({ key: b.key, parent: b.parent, depth: b.depth })),
    clips: gltf.animations.map((c, i) => ({ index: i, name: c.name || `Clip ${i + 1}`, seconds: c.duration })),
    onTick: null,
    on(event, fn) { handlers[event] = fn; },
    setDoc,
    // Tell the rig the document changed, so what it worked out from the keys is worked out again.
    invalidate() { rev += 1; },
    get frame() { return frame; },
    setFrame(f) {
      if (Math.round(f) !== Math.round(frame) && scratch.size) { scratch.clear(); handlers.scratch(0); }
      frame = f;
    },
    get activeLayer() { return active; },
    set activeLayer(i) { active = Math.max(0, Math.min(doc.layers.length - 1, i)); },
    get selection() { return selection; },
    select,
    get unkeyed() { return scratch.size; },
    unkeyedList: () => [...scratch].map(([key, pose]) => [key, Object.keys(pose)]),
    dropUnkeyed() { scratch.clear(); handlers.scratch(0); },
    setMode(next) { mode = next; if (selection?.type === "bone") gizmo.setMode(next); },
    setSpace(next) { space = next; if (selection?.type === "bone") gizmo.setSpace(next); },
    setBones(show) { overlay.visible = show; },
    setXray(on) { Object.values(mats).forEach((m) => { m.depthTest = !on; m.needsUpdate = true; }); },
    setOnion(on) { onion = on; if (on && !ghosts) makeGhosts(); if (ghosts) ghosts.forEach((g) => { g.root.visible = on; }); },
    keyBones,
    keyChannels,
    // The bone's local rotation and position as posed right now, for read-outs.
    pose(key) { return local(byKey.get(key)); },
    copyPose, restPose, applyPose, mirroredPose,
    get dragging() { return dragging; },
    // A small picture of the keyed pose at frame f, from the camera as it is now: the model alone, no bones or floor.
    snapshot(f, w, h) {
      const el = renderer.domElement;
      if (!doc || !el.width || !el.height) return "";
      const hidden = [overlay, gizmoHelper, fine, metres, ...(ghosts || []).map((g) => g.root)].map((o) => [o, o.visible]);
      hidden.forEach(([o]) => { o.visible = false; });
      evalPose(f, { unkeyed: false });
      holder.updateMatrixWorld(true);
      renderer.render(scene, camera);
      const out = document.createElement("canvas");
      out.width = w; out.height = h;
      // Frame the model: its bind-pose box as the camera sees it, with room around it for raised arms.
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, ahead = true;
      for (let i = 0; i < 8; i += 1) {
        _a.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
        if (_a.z > 1) ahead = false;
        x0 = Math.min(x0, _a.x); x1 = Math.max(x1, _a.x); y0 = Math.min(y0, _a.y); y1 = Math.max(y1, _a.y);
      }
      let sw = ((x1 - x0) / 2) * el.width * 1.3, sh = ((y1 - y0) / 2) * el.height * 1.3;
      let cx = ((x0 + x1) / 2 + 1) / 2 * el.width, cy = (1 - (y0 + y1) / 2) / 2 * el.height;
      if (!ahead || !(sw > 4 && sh > 4)) { sh = Math.min(el.height, (el.width * h) / w); sw = (sh * w) / h; cx = el.width / 2; cy = el.height / 2; }
      if (sw / sh < w / h) sw = (sh * w) / h; else sh = (sw * h) / w;
      out.getContext("2d").drawImage(el, cx - sw / 2, cy - sh / 2, sw, sh, 0, 0, w, h);
      hidden.forEach(([o, was]) => { o.visible = was; });
      return out.toDataURL();
    },
    ik: {
      auto() { const found = autoChains(); doc.ik.chains = found; refreshHandles(); return found.length; },
      add: addChain,
      remove(name) { doc.ik.chains = doc.ik.chains.filter((c) => c.name !== name); refreshHandles(); },
      refresh: refreshHandles,
      pinned: (name) => pins.has(name),
      pin(name, on) {
        const h = handles.get(name);
        if (!h) return;
        if (on) { holder.updateMatrixWorld(true); const tip = byKey.get(h.chain.tip); pins.set(name, { target: wp(tip, new THREE.Vector3()), tipQ: tip.bone.getWorldQuaternion(new THREE.Quaternion()) }); } else pins.delete(name);
        paint();
      },
      // Bend the middle joint the other way, tip staying where it is. Returns the bones that changed.
      invert(name) {
        const h = handles.get(name);
        if (!h) return [];
        evalPose(Math.round(frame), { mods: false });
        holder.updateMatrixWorld(true);
        const tip = byKey.get(h.chain.tip);
        solveChain(h.chain, wp(tip, new THREE.Vector3()), tip.bone.getWorldQuaternion(new THREE.Quaternion()), true);
        const keys = [h.chain.root, h.chain.mid, h.chain.tip];
        keys.forEach((key) => note(key, "r"));
        handlers.scratch(scratch.size);
        return keys.map((key) => [key, ["r"]]);
      },
    },
    // Every bone's local transform at every frame, as the tracks the baker writes, plus how fast the root travels.
    bakeSamples() {
      const times = [], held = bones.map(() => ({ rotation: [], translation: [], scale: [] })), last = bones.map(() => null);
      const root = bones.find((b) => !b.parent), start = new THREE.Vector3(), end = new THREE.Vector3();
      const round = (v) => Math.round(v * 1e6) / 1e6;
      for (let f = 0; f <= doc.frames; f += 1) {
        evalPose(f, { unkeyed: false });
        times.push(round(f / doc.fps));
        bones.forEach((b, i) => {
          const q = b.bone.quaternion, flip = last[i] && last[i].dot(q) < 0 ? -1 : 1;  // no long-way-round between samples
          last[i] = new THREE.Quaternion(q.x * flip, q.y * flip, q.z * flip, q.w * flip);
          held[i].rotation.push(round(last[i].x), round(last[i].y), round(last[i].z), round(last[i].w));
          held[i].translation.push(round(b.bone.position.x), round(b.bone.position.y), round(b.bone.position.z));
          held[i].scale.push(round(b.bone.scale.x), round(b.bone.scale.y), round(b.bone.scale.z));
        });
        if (f === 0 || f === doc.frames) { holder.updateMatrixWorld(true); wp(root, f === 0 ? start : end); }
      }
      const tracks = bones.flatMap((b, i) => (b.node === null ? [] : ["rotation", "translation", "scale"].map((path) => ({ node: b.node, path, values: held[i][path] }))));
      end.sub(start).setY(0);
      return { times, tracks, root_speed: round(end.length() / Math.max(doc.frames / doc.fps, 1e-6)) };
    },
    dispose() {
      running = false;
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      gizmo.detach(); gizmo.disconnect(); gizmoHelper.removeFromParent();
      orbit.dispose(); pmrem.dispose(); renderer.dispose(); renderer.domElement.remove();
    },
  };
  return api;
}
