// 3D preview, thumbnails and sprite sheets for GLB / glTF / OBJ / FBX files.
// Loaded on demand from app.js; three.js comes from the import map in index.html.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const ANGLES = {
  front: { azimuth: 0, elevation: 0 },
  side: { azimuth: 90, elevation: 0 },
  iso: { azimuth: 45, elevation: 30 },
  top: { azimuth: 0, elevation: 65 },
};

// Models exported elsewhere often point at textures by an absolute path on the exporting machine
// (e.g. /home/app/mixamo/…/skin.fbm/basecolor.png). Anything outside the model's own folder is looked up
// by file name next to the model instead, where Tessera keeps a model's textures.
function textureManager(url) {
  const base = new URL(url, location.href);
  const dir = base.href.slice(0, base.href.lastIndexOf("/") + 1);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((requested) => {
    if (requested.startsWith("data:") || requested.startsWith("blob:")) return requested;
    const resolved = new URL(requested.replace(/\\/g, "/"), dir).href;
    if (resolved.startsWith(dir)) return resolved;
    return dir + encodeURIComponent(decodeURIComponent(resolved.split("/").pop() || ""));
  });
  // Textures (embedded ones too) finish loading after the model itself; stills wait for them.
  let busy = false;
  const waiters = [];
  manager.onStart = () => { busy = true; };
  manager.onProgress = (_url, loaded, total) => { busy = loaded < total; };
  manager.onLoad = () => { busy = false; waiters.splice(0).forEach((done) => done()); };
  manager.settled = (ms = 15000) => (busy ? new Promise((done) => { waiters.push(done); setTimeout(done, ms); }) : Promise.resolve());
  return manager;
}

// The real format comes from the file's first bytes, not its name: rigs have arrived as FBX saved under a .glb name.
async function sniff(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the model (${res.status}).`);
  const buffer = await res.arrayBuffer();
  const head = new TextDecoder("latin1").decode(new Uint8Array(buffer, 0, Math.min(32, buffer.byteLength)));
  if (head.startsWith("glTF")) return { kind: "glb", buffer };
  if (head.startsWith("Kaydara FBX")) return { kind: "fbx", buffer };
  if (head.trimStart().startsWith("{")) return { kind: "gltf", buffer };
  if (head.startsWith("PK")) throw new Error("This is a USDZ (zip) file. Download it to open it in another app.");
  if (head.startsWith("solid") || /\.stl(\?|$)/i.test(url)) throw new Error("STL files are for printing and can't be previewed here. Download it instead.");
  return { kind: "text", buffer };
}

export async function loadModel(url) {
  const manager = textureManager(url);
  const ext = url.split("?")[0].split(".").pop().toLowerCase();
  const { kind, buffer } = await sniff(url);
  const dir = url.split("?")[0].slice(0, url.split("?")[0].lastIndexOf("/") + 1);
  let out;
  if (kind === "fbx" || (kind === "text" && ext === "fbx")) {
    const object = new FBXLoader(manager).parse(buffer, dir);
    out = { object, clips: object.animations || [] };
  } else if (kind === "glb" || kind === "gltf") {
    const gltf = await new GLTFLoader(manager).parseAsync(buffer, dir);
    out = { object: gltf.scene, clips: gltf.animations || [] };
  } else {
    out = { object: new OBJLoader(manager).parse(new TextDecoder().decode(buffer)), clips: [] };
  }
  await manager.settled();
  // Skinned meshes keep their bind-pose bounds; once animated they can leave them and get culled (the model vanishes).
  out.object.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
  return out;
}

function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a30, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffd6e0, 0.8);
  rim.position.set(-4, 3, -4);
  scene.add(rim);
}


// Centre the model on the ground at the origin and return its size.
function normalise(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  object.position.sub(new THREE.Vector3(centre.x, box.min.y, centre.z));
  return size;
}

function aim(camera, size, angle, ortho, distance = 1) {
  const a = ANGLES[angle] || ANGLES.front;
  const radius = Math.max(size.x, size.y, size.z) * (ortho ? 1.6 : 2.6) * distance + 0.001;
  const az = THREE.MathUtils.degToRad(a.azimuth);
  const el = THREE.MathUtils.degToRad(a.elevation);
  const target = new THREE.Vector3(0, size.y / 2, 0);
  camera.position.set(Math.sin(az) * Math.cos(el) * radius, target.y + Math.sin(el) * radius, Math.cos(az) * Math.cos(el) * radius);
  if (ortho) {
    const half = Math.max(size.x, size.y, size.z) * 0.62;
    Object.assign(camera, { left: -half, right: half, top: half, bottom: -half, near: 0.01, far: radius * 4 });
  } else {
    camera.near = radius / 100;
    camera.far = radius * 10;
  }
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  return target;
}

// Studio lighting for the interactive viewer: an image-based environment (RoomEnvironment, so it works offline),
// a key light that casts soft shadows onto an invisible floor, a rim and a fill, and presets for checking a model
// in other light. `az`/`el` place the key light (degrees); the viewer blends from one preset to the next.
export const LOOKS = {
  studio: { label: "Studio", env: 1, exposure: 1, hemi: 0.35, sky: 0xffffff, floor: 0x26262c, key: 2.4, keyColor: 0xffffff, az: 40, el: 52, rim: 0.7, rimColor: 0xc9d4ff, fill: 0, fillColor: 0xffffff, shadow: 0.32 },
  daylight: { label: "Daylight", env: 0.8, exposure: 1.05, hemi: 0.9, sky: 0xcfe4ff, floor: 0x5a4a3a, key: 3.2, keyColor: 0xfff1d6, az: 30, el: 62, rim: 0.3, rimColor: 0xffffff, fill: 0, fillColor: 0xffffff, shadow: 0.38 },
  sunset: { label: "Sunset", env: 0.45, exposure: 1, hemi: 0.5, sky: 0xffb38a, floor: 0x2a1630, key: 3, keyColor: 0xff9a52, az: 70, el: 14, rim: 2.2, rimColor: 0xff4fa3, fill: 0.35, fillColor: 0x6a5cff, shadow: 0.45 },
  neon: { label: "Neon", env: 0.15, exposure: 1.1, hemi: 0.12, sky: 0x6b4cff, floor: 0x09060f, key: 2.2, keyColor: 0xff3cac, az: 75, el: 28, rim: 3.2, rimColor: 0x2de2ff, fill: 1, fillColor: 0x7b5cff, shadow: 0.5 },
  night: { label: "Moonlight", env: 0.25, exposure: 0.85, hemi: 0.15, sky: 0x9fb4ff, floor: 0x0a0d18, key: 1.3, keyColor: 0x9fb4ff, az: -30, el: 48, rim: 1.4, rimColor: 0xbfd0ff, fill: 0, fillColor: 0xffffff, shadow: 0.4 },
  spotlight: { label: "Spotlight", env: 0.05, exposure: 1.1, hemi: 0.04, sky: 0xffffff, floor: 0x000000, key: 4.2, keyColor: 0xfff6e8, az: 10, el: 82, rim: 0.5, rimColor: 0xffffff, fill: 0, fillColor: 0xffffff, shadow: 0.7 },
  unlit: { label: "Unlit", env: 0, exposure: 1, hemi: 3, sky: 0xffffff, floor: 0xffffff, key: 0, keyColor: 0xffffff, az: 40, el: 52, rim: 0, rimColor: 0xffffff, fill: 0, fillColor: 0xffffff, shadow: 0 },
};
const LOOK_NUMS = ["env", "exposure", "hemi", "key", "az", "el", "rim", "fill", "shadow"];
const LOOK_COLORS = ["sky", "floor", "keyColor", "rimColor", "fillColor"];
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function frameBox(object, clips) {
  // Bounds over a few moments of the first clip too, so an animated model is framed with room to move.
  const box = new THREE.Box3().setFromObject(object, true);
  if (!clips.length) return box;
  const mixer = new THREE.AnimationMixer(object);
  const action = mixer.clipAction(clips[0]).play();
  for (let i = 1; i <= 6; i += 1) { mixer.setTime((clips[0].duration * i) / 6); object.updateMatrixWorld(true); box.union(new THREE.Box3().setFromObject(object, true)); }
  action.stop();
  mixer.uncacheRoot(object);
  return box;
}

// Interactive viewer inside `container`. Returns controls for clips, looks, display modes and stills.
// `autoRotate` turns the model slowly until the user grabs it; `grid: false` hides the floor grid.
export async function createViewer(container, url, { autoRotate = false, grid: showGrid = true, distance = 1 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x26262c, 0.35);
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 4;
  key.shadow.bias = -0.0005;
  const rim = new THREE.DirectionalLight(0xc9d4ff, 0.7);
  const fill = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(hemi, key, key.target, rim, fill);
  const grid = new THREE.GridHelper(10, 20, 0x3f3f46, 0x27272a);
  grid.visible = showGrid;
  scene.add(grid);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  const { object, clips } = await loadModel(url);
  scene.add(object);
  const size = normalise(object);
  const span = Math.max(size.x, size.y, size.z) || 1;
  grid.scale.setScalar(span / 3 || 1);
  // A floor that only shows the shadow.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32 }));
  ground.rotation.x = -Math.PI / 2;
  ground.scale.setScalar(span * 8);
  ground.receiveShadow = true;
  ground.userData.marker = true;
  scene.add(ground);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(span * 0.018, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfbbf24, depthTest: false, transparent: true }));
  marker.renderOrder = 12;
  marker.visible = false;
  scene.add(marker);
  const cam = key.shadow.camera;
  Object.assign(cam, { left: -span * 3, right: span * 3, top: span * 3, bottom: -span * 3, near: span * 0.1, far: span * 8 });
  cam.updateProjectionMatrix();
  object.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const fitSize = frameBox(object, clips).getSize(new THREE.Vector3()).max(size);

  // ---- lighting: the current values glide toward the chosen look's ----
  const lookNow = { ...LOOKS.studio };
  const lookGoal = { ...LOOKS.studio };
  LOOK_COLORS.forEach((k) => { lookNow[k] = new THREE.Color(LOOKS.studio[k]); lookGoal[k] = new THREE.Color(LOOKS.studio[k]); });
  let lightTurn = 0; // degrees the user turned the key light by hand (Shift-drag)
  const meshMaterials = [];
  object.traverse((o) => { if (o.isMesh) meshMaterials.push(...(Array.isArray(o.material) ? o.material : [o.material])); });
  const applyLook = () => {
    const l = lookNow;
    renderer.toneMappingExposure = l.exposure;
    scene.environment = l.env > 0.01 ? envMap : null;
    // three r163+ lights materials from scene.environment with scene.environmentIntensity (envMapIntensity only
    // applies to a material's own envMap), so both are set; the room turns with the key light.
    scene.environmentIntensity = l.env;
    meshMaterials.forEach((m) => { if ("envMapIntensity" in m && m.envMap) m.envMapIntensity = l.env; });
    if (scene.environmentRotation) scene.environmentRotation.y = THREE.MathUtils.degToRad(l.az + lightTurn - 40);
    hemi.intensity = l.hemi; hemi.color.copy(l.sky); hemi.groundColor.copy(l.floor);
    key.intensity = l.key; key.color.copy(l.keyColor);
    rim.intensity = l.rim; rim.color.copy(l.rimColor);
    fill.intensity = l.fill; fill.color.copy(l.fillColor);
    ground.material.opacity = l.shadow;
    ground.visible = l.shadow > 0.01 && l.key > 0.01;
    const az = THREE.MathUtils.degToRad(l.az + lightTurn);
    const el = THREE.MathUtils.degToRad(l.el);
    const r = span * 2.8;
    key.position.set(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, Math.cos(az) * Math.cos(el) * r);
    rim.position.set(-Math.sin(az) * span * 1.8, span * 1.3, -Math.cos(az) * span * 1.8);
    fill.position.set(-Math.cos(az) * span * 2, span * 0.6, Math.sin(az) * span * 2);
  };
  applyLook();
  let lookBlend = 1;
  const stepLook = (dt) => {
    if (lookBlend >= 1) return;
    lookBlend = Math.min(1, lookBlend + dt * 2.2);
    const k = 1 - Math.exp(-dt * 7);
    LOOK_NUMS.forEach((n) => { lookNow[n] += (lookGoal[n] - lookNow[n]) * (lookBlend >= 1 ? 1 : k); });
    LOOK_COLORS.forEach((n) => { lookNow[n].lerp(lookGoal[n], lookBlend >= 1 ? 1 : k); });
    applyLook();
  };

  const target = aim(camera, fitSize, "iso", false, distance);
  // Shift-drag turns the key light around the model; registered before OrbitControls so it can take the drag.
  let lightDrag = null;
  const lightListeners = new Set();
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (!e.shiftKey || e.button !== 0) return;
    lightDrag = { x: e.clientX, turn: lightTurn, id: e.pointerId };
    controls.enabled = false;
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!lightDrag) return;
    lightTurn = lightDrag.turn + (e.clientX - lightDrag.x) * 0.45;
    applyLook();
    lightListeners.forEach((fn) => fn(((lookNow.az + lightTurn) % 360 + 360) % 360, true));
  });
  const endLightDrag = () => {
    if (!lightDrag) return;
    lightDrag = null;
    controls.enabled = true;
    lightListeners.forEach((fn) => fn(((lookNow.az + lightTurn) % 360 + 360) % 360, false));
  };
  renderer.domElement.addEventListener("pointerup", endLightDrag);
  renderer.domElement.addEventListener("pointercancel", endLightDrag);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = autoRotate;
  controls.autoRotateSpeed = 1.2;
  controls.addEventListener("start", () => { controls.autoRotate = false; glide = null; turntableListeners.forEach((fn) => fn(false)); });
  const turntableListeners = new Set();
  // Camera glides between views instead of jumping.
  let glide = null;
  const glideTo = (pos, tgt, seconds = 0.7) => {
    glide = { t: 0, seconds, fromPos: camera.position.clone(), fromTgt: controls.target.clone(), toPos: pos.clone(), toTgt: tgt.clone() };
  };
  const stepGlide = (dt) => {
    if (!glide) return;
    glide.t = Math.min(1, glide.t + dt / glide.seconds);
    const e = ease(glide.t);
    camera.position.lerpVectors(glide.fromPos, glide.toPos, e);
    controls.target.lerpVectors(glide.fromTgt, glide.toTgt, e);
    if (glide.t >= 1) glide = null;
  };
  const aimGlide = (angle) => {
    const ghost = camera.clone();
    const t = aim(ghost, fitSize, angle, false, distance);
    camera.near = ghost.near; camera.far = ghost.far; camera.updateProjectionMatrix();
    glideTo(ghost.position, t);
  };
  const mixer = new THREE.AnimationMixer(object);
  let action = null;
  let paused = false;
  let speed = 1;
  let loopMode = "loop";
  let inPlace = false;
  let rootTrack = null;
  const clock = new THREE.Clock();
  let running = true;
  let skeleton = null;
  const listeners = new Set();
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  (function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1);
    if (action && !paused) mixer.update(dt * speed);
    if (inPlace && rootTrack) rootTrack.position.x = rootTrack.position.z = 0;
    stepLook(dt);
    stepGlide(dt);
    controls.update();
    renderer.render(scene, camera);
    if (action && listeners.size) listeners.forEach((fn) => fn(action.time, action.getClip().duration));
  })();
  const stats = { triangles: 0, meshes: 0, bones: 0, materials: new Set(), textures: new Set(), skinned: false };
  const originals = new Map();
  object.traverse((o) => {
    if (o.isMesh) {
      stats.meshes += 1;
      stats.triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
      originals.set(o, o.material);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { stats.materials.add(m.uuid); ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"].forEach((k) => m[k] && stats.textures.add(m[k].uuid)); });
    }
    if (o.isSkinnedMesh) stats.skinned = true;
    if (o.isBone) { stats.bones += 1; if (!rootTrack && !(o.parent && o.parent.isBone)) rootTrack = o; }
  });
  const boneNames = [];
  object.traverse((o) => { if (o.isBone) boneNames.push({ name: o.name, depth: (() => { let d = 0, p = o.parent; while (p && p.isBone) { d += 1; p = p.parent; } return d; })() }); });
  const placement = placementTools(scene, object, size, camera, renderer, controls);
  const display = {
    shaded: null,
    clay: () => new THREE.MeshStandardMaterial({ color: 0xbdbdc4, roughness: 0.85, metalness: 0 }),
    wire: () => new THREE.MeshBasicMaterial({ color: 0x9d8cff, wireframe: true }),
    normals: () => new THREE.MeshNormalMaterial(),
  };
  // A new clip blends in from the one playing (a short crossfade), so switching never snaps the pose.
  const startAction = (clip) => {
    const prev = action;
    const next = mixer.clipAction(clip);
    if (prev === next) { next.reset().play(); paused = false; return next; }
    next.setLoop(loopMode === "once" ? THREE.LoopOnce : loopMode === "pingpong" ? THREE.LoopPingPong : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = true;
    next.reset().setEffectiveWeight(1).play();
    if (prev && !paused) {
      prev.crossFadeTo(next, 0.35, false);
      setTimeout(() => { if (action !== prev) prev.stop(); }, 400);
    } else prev?.stop();
    action = next;
    paused = false;
    return action;
  };
  return {
    placement,
    clips: clips.map((c) => c.name || "Clip"),
    bones: boneNames,
    stats: { triangles: Math.round(stats.triangles), meshes: stats.meshes, bones: stats.bones, materials: stats.materials.size, textures: stats.textures.size, skinned: stats.skinned, height: size.y, size: { x: size.x, y: size.y, z: size.z } },
    // OBJ, STL or USDZ of what is on screen, made in the browser (FBX has no exporter).
    async exportAs(format) {
      placement.detach();
      try { return await exportObject(object, format); } finally { placement.attach(); }
    },
    play(index) {
      if (index >= 0 && clips[index]) startAction(clips[index]);
      else { action?.stop(); action = null; }
    },
    // A clip from another file (an FBX animation exported without its mesh) played on this model. It works when
    // the bone names match, as they do for clips exported from the same rig (Mixamo, Blender). Returns false if not.
    async playFrom(clipUrl) {
      const { clips: extra } = await loadModel(clipUrl);
      const clip = extra.find((c) => c.tracks.length) || null;
      if (!clip) return false;
      const bones = new Set();
      object.traverse((o) => bones.add(o.name));
      // Rotations carry the motion. Positions are dropped: a separate clip file may use other units or bone lengths
      // than this model (and its root motion would walk the model out of frame), so it plays in place.
      const tracks = clip.tracks.filter((t) => bones.has(t.name.split(".")[0]) && t.name.endsWith(".quaternion"));
      if (!tracks.length) return false;
      startAction(new THREE.AnimationClip(clip.name, clip.duration, tracks));
      controls.autoRotate = false;
      return true;
    },
    // ---- timeline ----
    onTime(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get playing() { return Boolean(action) && !paused; },
    get duration() { return action ? action.getClip().duration : 0; },
    pause(on = !paused) { paused = on; if (action && !on && !action.isRunning()) action.reset().play(); return paused; },
    seek(t) { if (!action) return; action.paused = false; action.time = Math.max(0, Math.min(t, action.getClip().duration)); mixer.update(0); },
    step(frames) { this.pause(true); this.seek((action?.time || 0) + frames / 30); },
    setSpeed(v) { speed = v; },
    setLoop(mode) { loopMode = mode; if (action) action.setLoop(mode === "once" ? THREE.LoopOnce : mode === "pingpong" ? THREE.LoopPingPong : THREE.LoopRepeat, Infinity); },
    setInPlace(on) { inPlace = on; },
    // ---- look ----
    // Blends to the look over about half a second (`instant` jumps).
    setLook(name, instant = false) {
      const l = LOOKS[name] || LOOKS.studio;
      LOOK_NUMS.forEach((n) => { lookGoal[n] = l[n]; });
      LOOK_COLORS.forEach((n) => lookGoal[n].setHex(l[n]));
      // Turn the short way round to the new light angle.
      lookNow.az = lookGoal.az + ((((lookNow.az - lookGoal.az) % 360) + 540) % 360 - 180);
      lookBlend = instant ? 0.999 : 0;
      if (instant) { LOOK_NUMS.forEach((n) => { lookNow[n] = lookGoal[n]; }); LOOK_COLORS.forEach((n) => lookNow[n].copy(lookGoal[n])); lookBlend = 1; applyLook(); }
    },
    // ---- light by hand, turntable, camera ----
    onLight(fn) { lightListeners.add(fn); return () => lightListeners.delete(fn); },
    resetLight() { lightTurn = 0; applyLook(); },
    setTurntable(on) { controls.autoRotate = on; turntableListeners.forEach((fn) => fn(on)); },
    get turntable() { return controls.autoRotate; },
    onTurntable(fn) { turntableListeners.add(fn); return () => turntableListeners.delete(fn); },
    setTurntableSpeed(v) { controls.autoRotateSpeed = v; },
    setDisplay(mode) {
      const make = display[mode];
      const cache = new Map();
      originals.forEach((orig, mesh) => {
        if (!make) { mesh.material = orig; return; }
        const m = cache.get(mode) || make();
        if (mesh.isSkinnedMesh && "skinning" in m) m.skinning = true;
        cache.set(mode, m);
        mesh.material = m;
      });
    },
    setSkeleton(on) {
      if (skeleton) { scene.remove(skeleton); skeleton.dispose?.(); skeleton = null; }
      if (!on || !stats.bones) return;
      skeleton = new THREE.SkeletonHelper(object);
      skeleton.material.depthTest = false;
      skeleton.material.color?.setHex?.(0x5eead4);
      skeleton.renderOrder = 11;
      scene.add(skeleton);
    },
    highlightBone(name) {
      const bone = name ? object.getObjectByName(name) : null;
      if (!bone) { marker.visible = false; return; }
      bone.getWorldPosition(marker.position);
      marker.visible = true;
    },
    setGrid(on) { grid.visible = on; },
    view(angle) { aimGlide(angle); if (controls.autoRotate) this.setTurntable(false); },
    frame() { aimGlide("iso"); },
    get clipIndex() { return action ? clips.indexOf(action.getClip()) : -1; },
    screenshot(transparent = true) {
      const was = [grid.visible, scene.background];
      grid.visible = false;
      if (!transparent) scene.background = new THREE.Color(0x101014);
      placement.detach();
      renderer.render(scene, camera);
      const data = renderer.domElement.toDataURL("image/png");
      placement.attach();
      [grid.visible, scene.background] = was;
      return data;
    },
    still() {
      grid.visible = false;
      placement.detach();
      renderer.render(scene, camera);
      const data = renderer.domElement.toDataURL("image/png");
      placement.attach();
      grid.visible = showGrid;
      return data;
    },
    dispose() {
      running = false;
      listeners.clear();
      placement.cancelPick();
      placement.dispose();
      observer.disconnect();
      controls.dispose();
      envMap.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

// ---- placement: what a game needs to put the model in the world ----
// A 1.8 m figure beside the model (sized from the height the user gives it), an arrow on the floor out of the
// model's front, and markers for named points. Points live in the model's own coordinates (the file as a game
// imports it), so the markers are children of the loaded object and picking converts hits into its frame.

const FIGURE_M = 1.8;
const FRONT_DIRS = { "+Z": [0, 0, 1], "-Z": [0, 0, -1], "+X": [1, 0, 0], "-X": [-1, 0, 0] };
const POINT_COLORS = { auto: 0xa1a1aa, bone: 0x2dd4bf, user: 0xff5c8a };

function textSprite(text, color, height) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = "600 40px system-ui, sans-serif";
  canvas.width = Math.ceil(ctx.measureText(text).width) + 28;
  canvas.height = 60;
  ctx.font = "600 40px system-ui, sans-serif";
  ctx.fillStyle = "rgba(15,15,20,0.78)";
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, 14);
  ctx.fill();
  ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 14, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function placementTools(scene, object, size, camera, renderer, orbit) {
  const span = Math.max(size.x, size.y, size.z) || 1;
  // The object was moved so it stands on the origin; this undoes that for the figure and arrow, which sit in the scene.
  const extras = new THREE.Group();
  scene.add(extras);
  const markers = new THREE.Group();
  markers.userData.marker = true;
  object.add(markers);
  let figure = null;
  let arrow = null;
  const clear = (group) => { while (group.children.length) { const c = group.children.pop(); c.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); } };

  function setHeight(metres) {
    if (figure) { extras.remove(figure); figure.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); figure = null; }
    const m = Number(metres);
    if (!(m > 0) || !(size.y > 0)) return;
    const h = (FIGURE_M * size.y) / m; // the figure's height in the model's units
    const r = h * 0.12;
    const material = new THREE.MeshStandardMaterial({ color: 0x8a8aa0, roughness: 0.9, transparent: true, opacity: 0.6 });
    figure = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, h * 0.82 - 2 * r), 6, 12), material);
    body.position.y = (h * 0.82) / 2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(h * 0.075, 16, 12), material);
    head.position.y = h * 0.82 + h * 0.07;
    figure.add(body, head);
    figure.position.x = -(size.x / 2 + r + Math.max(span, h) * 0.12);
    extras.add(figure);
  }

  function setFront(front) {
    if (arrow) { extras.remove(arrow); arrow.dispose?.(); arrow = null; }
    const d = FRONT_DIRS[front];
    if (!d) return;
    const reach = Math.max(size.x, size.z) / 2 + span * 0.35;
    arrow = new THREE.ArrowHelper(new THREE.Vector3(...d), new THREE.Vector3(0, span * 0.004, 0), reach, 0xff5c8a, span * 0.12, span * 0.07);
    extras.add(arrow);
  }

  // Moving a point by hand: a gizmo with three arrows on the selected user point. Dragging it never turns the camera;
  // letting go reports the new spot (in the model's own coordinates) to whoever listens.
  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setMode("translate");
  gizmo.setSize(0.75);
  const gizmoHelper = gizmo.getHelper();
  gizmoHelper.userData.marker = true;
  gizmoHelper.traverse((o) => { o.userData.marker = true; });
  scene.add(gizmoHelper);
  const byName = new Map();
  let selected = "";
  let onSelect = () => {};
  let onMove = () => {};
  const round = (v) => Math.round(v * 10000) / 10000;
  const posOf = (dot) => [dot.position.x, dot.position.y, dot.position.z].map(round);
  gizmo.addEventListener("dragging-changed", (e) => {
    orbit.enabled = !e.value;
    if (!e.value && selected && byName.has(selected)) onMove(selected, posOf(byName.get(selected).dot));
  });
  gizmo.addEventListener("objectChange", () => {
    const entry = byName.get(selected);
    if (!entry) return;
    entry.tag.position.set(entry.dot.position.x, entry.dot.position.y + span * 0.04, entry.dot.position.z);
    onSelect(selected, posOf(entry.dot), true);
  });
  function selectPoint(name) {
    const entry = byName.get(name);
    selected = entry ? name : "";
    if (entry) gizmo.attach(entry.dot); else gizmo.detach();
    onSelect(selected, entry ? posOf(entry.dot) : null, false);
  }
  // Snap steps in the model's units while dragging (0 = free).
  function setSnap(step) { gizmo.setTranslationSnap(step > 0 ? step : null); }
  // Set a point's spot from typed numbers, without a save round trip first.
  function movePoint(name, xyz) {
    const entry = byName.get(name);
    if (!entry) return;
    entry.dot.position.set(...xyz);
    entry.tag.position.set(xyz[0], xyz[1] + span * 0.04, xyz[2]);
  }

  // [{ name, xyz: [x, y, z], type: "auto" | "bone" | "user" }]
  function setPoints(points) {
    gizmo.detach();
    byName.clear();
    clear(markers);
    for (const p of points) {
      const color = POINT_COLORS[p.type] || POINT_COLORS.user;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(span * 0.014, 14, 10), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
      dot.renderOrder = 9;
      dot.position.set(...p.xyz);
      dot.userData.marker = true;
      const tag = textSprite(p.name, color, span * 0.035);
      tag.position.set(p.xyz[0], p.xyz[1] + span * 0.04, p.xyz[2]);
      tag.userData.marker = true;
      markers.add(dot, tag);
      if (p.type === "user") { dot.userData.point = p.name; byName.set(p.name, { dot, tag }); }
    }
    if (selected && byName.has(selected)) gizmo.attach(byName.get(selected).dot);
    else if (selected) { selected = ""; onSelect("", null, false); }
  }

  // A plain click on a user point's marker selects it (when not placing a new point).
  const ndc = (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  };
  let pressAt = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { pressAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (pending || gizmo.dragging || !pressAt || Math.hypot(e.clientX - pressAt[0], e.clientY - pressAt[1]) > 5) return;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc(e), camera);
    const hit = ray.intersectObjects([...byName.values()].map((v) => v.dot), false)[0];
    if (hit) selectPoint(hit.object.userData.point);
  });

  const raycaster = new THREE.Raycaster();
  let pending = null;
  function cancelPick() {
    if (!pending) return;
    pending.stop();
    pending.resolve(null);
    pending = null;
  }
  // Resolves with the clicked spot in the model's own coordinates, or null (Escape, or the viewer closed).
  function pickPoint() {
    cancelPick();
    const el = renderer.domElement;
    return new Promise((resolve) => {
      let down = null;
      const onDown = (e) => { down = [e.clientX, e.clientY]; };
      const onUp = (e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return; // a drag turns the camera
        const rect = el.getBoundingClientRect();
        raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
        const hit = raycaster.intersectObject(object, true).find((h) => !h.object.userData.marker && h.object.visible);
        if (!hit) return;
        object.updateMatrixWorld(true);
        const local = object.worldToLocal(hit.point.clone());
        finish([local.x, local.y, local.z].map((v) => Math.round(v * 10000) / 10000));
      };
      const onKey = (e) => { if (e.key === "Escape") finish(null); };
      const stop = () => {
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("pointerup", onUp);
        document.removeEventListener("keydown", onKey, true);
        el.style.cursor = "";
      };
      const finish = (value) => { stop(); pending = null; resolve(value); };
      el.style.cursor = "crosshair";
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointerup", onUp);
      document.addEventListener("keydown", onKey, true);
      pending = { stop, resolve };
    });
  }

  // Exports and stills are of the model alone: the figure, arrow and markers step out while they are made.
  // `shown` false keeps them out of view entirely (the full-window viewer shows them only with its details open).
  let shown = true;
  const detach = () => { object.remove(markers); extras.visible = false; gizmoHelper.visible = false; };
  const attach = () => { if (!shown) return; object.add(markers); extras.visible = true; gizmoHelper.visible = true; };
  const setShown = (on) => { shown = on; if (on) attach(); else { if (pending) cancelPick(); detach(); } };
  return {
    setHeight, setFront, setPoints, pickPoint, cancelPick, detach, attach, selectPoint, movePoint, setSnap, setShown,
    onSelect(cb) { onSelect = cb; },
    onMove(cb) { onMove = cb; },
    // three r169's TransformControls.dispose() calls this.traverse, which the controls (no longer an Object3D) lack.
    dispose() { gizmo.detach(); gizmo.disconnect(); gizmoHelper.removeFromParent(); gizmoHelper.dispose?.(); },
    picking: () => Boolean(pending),
  };
}

const EXPORTERS = {
  obj: ["OBJExporter", (E, o) => new E().parse(o), "text/plain"],
  stl: ["STLExporter", (E, o) => new E().parse(o, { binary: true }), "model/stl"],
  usdz: ["USDZExporter", (E, o) => new E().parseAsync(o), "model/vnd.usdz+zip"],
};

export async function exportObject(object, format) {
  const [name, run, type] = EXPORTERS[format];
  const mod = await import(`three/addons/exporters/${name}.js`);
  const data = await run(mod[name], object);
  return new Blob([data], { type });
}

// Every model of a project side by side on one floor, each scaled to its height in metres, with a
// 1.8 m figure at the left for scale. `items`: [{ url, height, label }].
export async function createLineup(container, items) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  lights(scene);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
  const human = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.36, 6, 12), new THREE.MeshStandardMaterial({ color: 0x8a8aa0, roughness: 0.9, transparent: true, opacity: 0.55 }));
  human.position.y = 0.9;
  scene.add(human);
  let x = 0.6;
  const placed = [{ label: "1.8 m person", x: 0, height: 1.8 }];
  for (const item of items) {
    try {
      const { object } = await loadModel(item.url);
      const raw = normalise(object);
      const scale = (item.height || 1) / Math.max(raw.y, 0.0001);
      object.scale.multiplyScalar(scale);
      const width = Math.max(raw.x, raw.z) * scale;
      const holder = new THREE.Group();
      holder.add(object);
      holder.position.x = x + width / 2;
      scene.add(holder);
      placed.push({ label: item.label, x: x + width / 2, height: item.height });
      x += width + 0.4;
    } catch { /* a model that fails to load is left out of the line */ }
  }
  const tallest = Math.max(...placed.map((p) => p.height), 1.8);
  const centre = new THREE.Vector3(x / 2, tallest / 2, 0);
  const grid = new THREE.GridHelper(Math.max(x, tallest) * 2, 20, 0x3f3f46, 0x27272a);
  grid.position.x = centre.x;
  scene.add(grid);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(centre);
  controls.enableDamping = true;
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    const fit = Math.max(x / camera.aspect, tallest) * 1.25;
    camera.position.set(centre.x, centre.y + fit * 0.25, fit / (2 * Math.tan(THREE.MathUtils.degToRad(15))));
    camera.near = 0.01; camera.far = fit * 20;
    camera.updateProjectionMatrix();
    controls.update();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  let running = true;
  (function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();
  return {
    placed,
    dispose() { running = false; observer.disconnect(); controls.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
}

function offscreen(size) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

// A square, transparent preview picture of the model.
export async function renderThumb(url, size = 512) {
  const renderer = offscreen(size);
  const scene = new THREE.Scene();
  lights(scene);
  const { object } = await loadModel(url);
  scene.add(object);
  const dims = normalise(object);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  aim(camera, dims, "iso", false);
  renderer.render(scene, camera);
  const data = renderer.domElement.toDataURL("image/png");
  renderer.dispose();
  return data;
}

// Sprite sheet: one row per direction, one column per animation frame.
export async function renderSpriteSheet(url, { clip = -1, frames = 8, directions = 8, size = 128, angle = "iso" } = {}) {
  const renderer = offscreen(size);
  const scene = new THREE.Scene();
  lights(scene);
  const { object, clips } = await loadModel(url);
  const pivot = new THREE.Group();
  pivot.add(object);
  scene.add(pivot);
  const dims = normalise(object);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  aim(camera, dims, angle, true);
  const mixer = new THREE.AnimationMixer(object);
  const anim = clips[clip];
  const action = anim ? mixer.clipAction(anim).play() : null;
  const cols = anim ? Math.max(1, Math.min(64, frames)) : 1;
  const rows = Math.max(1, Math.min(16, directions));
  const sheet = document.createElement("canvas");
  sheet.width = cols * size;
  sheet.height = rows * size;
  const ctx = sheet.getContext("2d");
  for (let row = 0; row < rows; row += 1) {
    pivot.rotation.y = (row / rows) * Math.PI * 2;
    for (let col = 0; col < cols; col += 1) {
      if (action) mixer.setTime((anim.duration * col) / cols);
      renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, col * size, row * size);
    }
  }
  renderer.dispose();
  return {
    dataUrl: sheet.toDataURL("image/png"),
    meta: {
      frame_width: size, frame_height: size, columns: cols, rows,
      directions: rows, frames_per_direction: cols, angle,
      clip: anim?.name || "", clip_seconds: anim ? Number(anim.duration.toFixed(3)) : 0,
      fps: anim ? Math.round(cols / Math.max(anim.duration, 0.001)) : 0,
      direction_order: "row 0 is the camera view, then the model turns counter-clockwise seen from above",
    },
  };
}
