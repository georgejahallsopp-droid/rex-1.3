// Optional real AI-generated model viewer using three.js. Only imported
// (dynamically, from app.js) when a Meshy AI key is set and a generation
// succeeds, so the base app never depends on three.js being present.
// Requires renderer/vendor/ to exist - populated by `npm install`'s
// postinstall step (scripts/prepare-vendor.js) from the three.js package.

import * as THREE from 'three';
import { OrbitControls } from './vendor/jsm/controls/OrbitControls.js';
import { GLTFLoader } from './vendor/jsm/loaders/GLTFLoader.js';

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v && v.trim() ? v.trim() : fallback;
}

export function initMeshyViewer(canvas, glbArrayBuffer) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(0, 0, 3);

  const accentHex = cssVar('--accent', '#35f4e0');
  scene.add(new THREE.HemisphereLight(0xbfffee, 0x081210, 1.15));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(2, 3, 4);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(new THREE.Color(accentHex), 0.9);
  rimLight.position.set(-3, -1, -2);
  scene.add(rimLight);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.1;

  let disposed = false;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width),
      h = Math.max(1, rect.height);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  function frame() {
    if (disposed) return;
    requestAnimationFrame(frame);
    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  const loader = new GLTFLoader();
  const ready = new Promise((resolve, reject) => {
    try {
      loader.parse(
        glbArrayBuffer,
        '',
        (gltf) => {
          const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
          if (!root) {
            reject(new Error('No scene in model file'));
            return;
          }
          const box = new THREE.Box3().setFromObject(root);
          const size = new THREE.Vector3();
          box.getSize(size);
          const center = new THREE.Vector3();
          box.getCenter(center);
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const scale = 1.6 / maxDim;
          root.scale.setScalar(scale);
          root.position.sub(center.multiplyScalar(scale));
          scene.add(root);
          resolve();
        },
        (err) => reject(err instanceof Error ? err : new Error(String(err)))
      );
    } catch (err) {
      reject(err);
    }
  });

  return {
    ready,
    dispose() {
      disposed = true;
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    },
  };
}
