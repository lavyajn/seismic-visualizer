import React, { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls, Stars, Html } from '@react-three/drei';
import * as THREE from 'three';

// --- CONFIGURATION ---
const WS_URL = 'ws://localhost:8080';
const GLOBE_RADIUS = 2; 

const TEXTURES = {
  color: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_atmos_2048.jpg',
  normal: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_normal_2048.jpg',
  water: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_specular_2048.jpg',
  clouds: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_clouds_1024.png'
};

const TECTONIC_PLATES_URL = 'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json';

// --- GLSL SHADERS ---

const atmosphereVertexShader = `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const atmosphereFragmentShader = `
  varying vec3 vNormal;
  void main() {
    float intensity = pow(0.65 - dot(vNormal, vec3(0, 0, 1.0)), 4.0);
    gl_FragColor = vec4(0.3, 0.6, 1.0, 1.0) * intensity;
  }
`;

// FIXED LIQUID SHADER
const rippleVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const rippleFragmentShader = `
  uniform vec3 uColor;
  uniform float time;
  varying vec2 vUv;

  void main() {
    float dist = distance(vUv, vec2(0.5));
    if (dist > 0.5) discard;
    
    // Concentric expanding liquid rings
    float wave = sin((dist * 30.0) - (time * 5.0));
    
    // Sharpen the peaks of the waves so they look distinct and bright
    wave = smoothstep(0.6, 1.0, wave);
    
    // Fade out smoothly at the edge, and fade out the direct center
    float edgeFade = smoothstep(0.5, 0.2, dist) * smoothstep(0.0, 0.1, dist);
    
    // Push the assigned color with a strong alpha
    gl_FragColor = vec4(uColor, wave * edgeFade * 0.95);
  }
`;

// --- THE MATH VAULT ---
const latLongToVector3 = (lat, lng, radius, depthKm = 0) => {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  const actualRadius = radius - (depthKm * 0.001); 
  const x = -(actualRadius * Math.sin(phi) * Math.cos(theta));
  const z = (actualRadius * Math.sin(phi) * Math.sin(theta));
  const y = (actualRadius * Math.cos(phi));
  return new THREE.Vector3(x, y, z);
};

const formatUTCTime = (timestamp) => {
  if (!timestamp) return 'WAITING...';
  return new Date(timestamp).toLocaleTimeString('en-US', { 
    hour12: false, timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }) + ' UTC';
};

// --- COMPONENTS ---

const CameraRig = ({ activeQuake }) => {
  const { camera } = useThree();
  const targetPos = useRef(new THREE.Vector3(0, 0, 6)); 
  const isFlying = useRef(false);

  useEffect(() => {
    if (activeQuake) {
      const { latitude, longitude } = activeQuake.coordinates;
      const surfacePos = latLongToVector3(latitude, longitude, GLOBE_RADIUS);
      // Pushed camera even further back (5.5) so the tethered HUD fits on screen
      targetPos.current.copy(surfacePos).normalize().multiplyScalar(5.5);
      isFlying.current = true;
    }
  }, [activeQuake]);

  useFrame(() => {
    if (isFlying.current) {
      camera.position.lerp(targetPos.current, 0.015);
      if (camera.position.distanceTo(targetPos.current) < 0.1) {
        isFlying.current = false;
      }
    }
  });
  return null;
};

const Globe = () => {
  const [colorMap, normalMap, waterMap, cloudMap] = useLoader(THREE.TextureLoader, [
    TEXTURES.color, TEXTURES.normal, TEXTURES.water, TEXTURES.clouds
  ]);
  const cloudsRef = useRef();
  useFrame(() => { if (cloudsRef.current) cloudsRef.current.rotation.y += 0.00005; });

  return (
    <group>
      <mesh receiveShadow castShadow>
        <sphereGeometry args={[GLOBE_RADIUS, 64, 64]} />
        <meshPhongMaterial map={colorMap} normalMap={normalMap} specularMap={waterMap} specular={new THREE.Color('#333333')} shininess={15} />
      </mesh>
      <mesh ref={cloudsRef} castShadow receiveShadow>
        <sphereGeometry args={[GLOBE_RADIUS + 0.006, 64, 64]} />
        <meshStandardMaterial map={cloudMap} transparent={true} opacity={0.6} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[GLOBE_RADIUS * 1.15, 64, 64]} />
        <shaderMaterial vertexShader={atmosphereVertexShader} fragmentShader={atmosphereFragmentShader} blending={THREE.AdditiveBlending} side={THREE.BackSide} transparent={true} depthWrite={false} />
      </mesh>
    </group>
  );
};

const TectonicPlates = () => {
  const [plateLines, setPlateLines] = useState([]);
  useEffect(() => {
    fetch(TECTONIC_PLATES_URL)
      .then(res => res.json())
      .then(data => {
        const lines = data.features.map(feature => 
          feature.geometry.coordinates.map(c => latLongToVector3(c[1], c[0], GLOBE_RADIUS + 0.002))
        );
        setPlateLines(lines);
      }).catch(err => console.error("Failed to load tectonic plates", err));
  }, []);

  return (
    <group>
      {plateLines.map((points, index) => (
        <line key={index} geometry={new THREE.BufferGeometry().setFromPoints(points)}>
          <lineBasicMaterial color="#ff4400" transparent={true} opacity={0.3} blending={THREE.AdditiveBlending} />
        </line>
      ))}
    </group>
  );
};

const QuakeRipple = ({ quake, activeQuake, setActiveQuake }) => {
  const meshRef = useRef();
  const materialRef = useRef();
  const tsunamiRef = useRef();
  const tsunamiMatRef = useRef();
  const [hovered, setHovered] = useState(false);
  
  const { latitude, longitude, depth } = quake.coordinates;
  const mag = quake.magnitude;
  const isActive = activeQuake?.id === quake.id;
  const hasTsunami = quake.tsunami === 1; // It's back.
  
  const pos = useMemo(() => latLongToVector3(latitude, longitude, GLOBE_RADIUS + 0.008, depth), [latitude, longitude, depth]);
  
  // Base scale significantly increased so they are visible
  const baseScale = useMemo(() => Math.max(0.08, mag * 0.04), [mag]);
  
  const rippleColorStr = useMemo(() => {
    if (mag > 5) return '#ff0000';
    if (mag > 3) return '#ffaa00';
    return '#00ffaa';
  }, [mag]);

  const uniforms = useMemo(() => ({
    uColor: { value: new THREE.Color(rippleColorStr) },
    time: { value: 0 }
  }), [rippleColorStr]);

  const timeOffset = useMemo(() => Math.random() * 5, []);

  // Calculate the physical tether line pointing outward into space
  const tetherPoints = useMemo(() => [
    new THREE.Vector3(0, 0, 0),       // Starts at the crust
    new THREE.Vector3(0, 0, -1.8)     // Ends 1.8 units away in space (Z is inverted relative to the planet core)
  ], []);
  const tetherGeom = useMemo(() => new THREE.BufferGeometry().setFromPoints(tetherPoints), [tetherPoints]);

  useEffect(() => {
    document.body.style.cursor = hovered ? 'pointer' : 'auto';
  }, [hovered]);

  useFrame((state) => {
    if (!meshRef.current || !materialRef.current) return;
    const time = state.clock.getElapsedTime();

    // Pump time into the liquid shader
    materialRef.current.uniforms.time.value = time;

    // Expand the ripple slightly on hover/active
    const targetScale = (isActive || hovered) ? baseScale * 1.5 : baseScale;
    meshRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, 1), 0.1);

    // Re-implemented Tsunami logic
    if (hasTsunami && tsunamiRef.current && tsunamiMatRef.current) {
        const tProgress = ((time + timeOffset) % 5.0) / 5.0; 
        const tScale = 0.2 + (tProgress * 0.6); 
        tsunamiRef.current.scale.set(tScale, tScale, 1);
        tsunamiMatRef.current.opacity = (1.0 - tProgress) * 0.5; 
    }
  });

  return (
    <group position={pos} onUpdate={self => self.lookAt(0,0,0)}>
      {/* Invisible Hitbox */}
      <mesh 
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
        onPointerOut={() => setHovered(false)}
        onClick={(e) => { e.stopPropagation(); setActiveQuake(isActive ? null : quake); }}
      >
        <sphereGeometry args={[baseScale * 0.6, 16, 16]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      {/* The Liquid Plane Shader */}
      <mesh ref={meshRef}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial 
          ref={materialRef}
          vertexShader={rippleVertexShader}
          fragmentShader={rippleFragmentShader}
          uniforms={uniforms}
          transparent={true} 
          blending={THREE.AdditiveBlending} 
          side={THREE.DoubleSide}
          depthWrite={false} 
        />
      </mesh>

      {/* Tsunami Warning Ring */}
      {hasTsunami && (
        <mesh ref={tsunamiRef} position={[0,0,-0.001]}> 
          <ringGeometry args={[0.8, 1, 64]} />
          <meshBasicMaterial ref={tsunamiMatRef} color="#00ffff" side={THREE.DoubleSide} transparent={true} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      )}

      {/* TETHER & HUD IN SPACE */}
      {isActive && (
        <>
          <line geometry={tetherGeom}>
            <lineBasicMaterial color={rippleColorStr} transparent={true} opacity={0.6} />
          </line>

          {/* Anchor the HTML directly to the end of the line (0, 0, -1.8) */}
          <Html position={[0, 0, -1.8]} center zIndexRange={[100, 0]}>
            {/* Added a tiny custom inline animation so it fades in nicely */}
            <div 
              style={{ animation: 'fadeIn 0.4s ease-out forwards' }}
              className="bg-slate-900 border-2 border-teal-500 p-4 rounded-lg text-white text-sm font-sans min-w-[280px] shadow-2xl pointer-events-none select-none opacity-0"
            >
              <style>{`@keyframes fadeIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }`}</style>
              
              <div className="flex justify-between items-center mb-3 border-b border-slate-700 pb-2">
                  <span className={`${hasTsunami ? 'text-cyan-400' : 'text-teal-400'} font-bold uppercase tracking-widest text-xs`}>
                    {hasTsunami ? 'TSUNAMI WARNING' : 'EVENT LOG'}
                  </span>
                  <span className="text-slate-300 font-mono text-xs">{formatUTCTime(quake.time)}</span>
              </div>
              
              <div className="space-y-3">
                <p className="whitespace-normal font-medium leading-relaxed">
                  <span className="text-slate-400 font-mono text-xs block mb-1">LOCATION</span> 
                  {quake.place}
                </p>
                
                <div className="grid grid-cols-2 gap-4 border-t border-slate-700 pt-3">
                    <div>
                      <span className="text-slate-400 font-mono text-xs block">LATITUDE</span>
                      <span className="font-mono">{latitude.toFixed(4)}°</span>
                    </div>
                    <div>
                      <span className="text-slate-400 font-mono text-xs block">LONGITUDE</span>
                      <span className="font-mono">{longitude.toFixed(4)}°</span>
                    </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4 bg-slate-800 p-2 rounded mt-2">
                    <div>
                      <span className="text-slate-400 font-mono text-xs block">MAGNITUDE</span>
                      <span className={`text-lg font-bold ${mag > 5 ? 'text-red-500' : mag > 3 ? 'text-orange-400' : 'text-teal-400'}`}>
                        {mag.toFixed(2)}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 font-mono text-xs block">DEPTH</span>
                      <span className="text-lg font-bold text-slate-200">{depth.toFixed(1)} <span className="text-sm font-normal">km</span></span>
                    </div>
                </div>
              </div>
            </div>
          </Html>
        </>
      )}
    </group>
  );
};

export default function App() {
  const [lastJsonMessage, setLastJsonMessage] = useState(null);
  const [readyState, setReadyState] = useState(0);
  const [activeQuake, setActiveQuake] = useState(null); 

  useEffect(() => {
    let ws;
    let reconnectTimeout;

    const connect = () => {
      setReadyState(0); 
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setReadyState(1); 
      ws.onmessage = (event) => {
        try {
          setLastJsonMessage(JSON.parse(event.data));
        } catch (e) {
          console.error('WebSocket payload parsing failed', e);
        }
      };
      ws.onclose = () => {
        setReadyState(3); 
        reconnectTimeout = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => { clearTimeout(reconnectTimeout); if (ws) { ws.onclose = null; ws.close(); } };
  }, []);

  const earthquakeData = lastJsonMessage?.events || [];
  const totalQuakes = lastJsonMessage?.count || 0;

  const topQuakes = useMemo(() => {
    return [...earthquakeData].sort((a, b) => b.magnitude - a.magnitude).slice(0, 10);
  }, [earthquakeData]);

  const connectionStatus = {
    0: 'CONNECTING...', 1: 'LIVE DATA STREAM OPEN', 2: 'DISCONNECTING...', 3: 'OFFLINE - RETRYING...',
  }[readyState];

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative font-sans text-white m-0 p-0 flex">
      
      {/* --- HUD OVERLAY (LEFT) --- */}
      <div className="absolute inset-y-0 left-0 pointer-events-none z-10 p-8 flex flex-col justify-between">
        <div>
          <h1 className="text-5xl font-black text-teal-400 tracking-tight drop-shadow-md mb-4">SEISMIC</h1>
          <div className="bg-slate-900/80 border border-slate-700 p-4 rounded-lg backdrop-blur-md space-y-2 inline-block">
            <p className="text-sm text-slate-300 font-mono">STATUS: <span className={readyState === 1 ? 'text-teal-400 font-bold' : 'text-red-500 font-bold'}>[{connectionStatus}]</span></p>
            <p className="text-sm text-slate-300 font-mono">ANOMALIES: <span className="text-white font-bold">{totalQuakes}</span></p>
            <p className="text-sm text-slate-300 font-mono">LAST SYNC: <span className="text-white font-bold">{formatUTCTime(lastJsonMessage?.timestamp)}</span></p>
          </div>
        </div>

        <div className="bg-slate-900/80 border border-slate-700 p-4 rounded-lg backdrop-blur-md inline-block pointer-events-auto">
          <h3 className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-3 border-b border-slate-700 pb-2">Threat Legend</h3>
          <div className="text-sm text-slate-200 space-y-3 font-medium">
            <div className="flex items-center">
              <div className="w-4 h-4 bg-teal-400 mr-3 rounded-full shadow-[0_0_12px_#2dd4bf]"></div>
              <span>Minor (&lt; 3.0)</span>
            </div>
            <div className="flex items-center">
              <div className="w-4 h-4 bg-orange-400 mr-3 rounded-full shadow-[0_0_12px_#fb923c]"></div>
              <span>Moderate (3.0 - 5.0)</span>
            </div>
            <div className="flex items-center">
              <div className="w-4 h-4 bg-red-600 mr-3 rounded-full shadow-[0_0_12px_#dc2626]"></div>
              <span>Severe (&gt; 5.0)</span>
            </div>
            <div className="flex items-center pt-2">
              <div className="w-3 h-3 border-2 border-cyan-400 mr-3 rounded-full shadow-[0_0_10px_#22d3ee]"></div>
              <span className="text-cyan-400 font-bold tracking-widest">TSUNAMI ALERT</span>
            </div>
          </div>
        </div>
      </div>

      {/* --- SIDEBAR PANEL (RIGHT) --- */}
      <div className="absolute inset-y-0 right-0 w-96 bg-slate-900 border-l border-slate-700 shadow-2xl z-10 flex flex-col pointer-events-auto">
        <div className="p-6 border-b border-slate-700 bg-slate-800">
          <h2 className="text-white font-black tracking-wide text-xl uppercase">Priority Targets</h2>
          <p className="text-xs text-slate-400 mt-1 font-mono">Global Top 10 by Magnitude</p>
        </div>
        
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3 custom-scrollbar">
          {topQuakes.map((quake) => (
            <div 
              key={quake.id} 
              onClick={() => setActiveQuake(quake)}
              className={`p-4 rounded-lg cursor-pointer transition-all border-2 ${activeQuake?.id === quake.id ? 'bg-slate-800 border-teal-500 shadow-lg scale-[1.02]' : 'bg-slate-800/50 border-slate-700 hover:border-slate-500 hover:bg-slate-800'}`}
            >
              <div className="flex justify-between items-center mb-2">
                <span className={`font-black text-2xl leading-none ${quake.magnitude > 5 ? 'text-red-500' : quake.magnitude > 3 ? 'text-orange-400' : 'text-teal-400'}`}>
                  {quake.magnitude.toFixed(1)}
                </span>
                <span className="text-xs text-slate-400 font-mono bg-slate-900 px-2 py-1 rounded">{formatUTCTime(quake.time).split(' ')[0]}</span>
              </div>
              <p className="text-sm text-slate-200 font-medium whitespace-normal leading-snug">{quake.place}</p>
              {quake.tsunami === 1 && (
                <div className="mt-2 text-[9px] text-black bg-cyan-400 px-1 py-0.5 inline-block font-bold rounded uppercase tracking-wider">
                  Tsunami Risk
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* --- 3D CANVAS --- */}
      <Canvas 
        camera={{ position: [0, 0, 6], fov: 60 }} 
        className="block w-full h-full absolute inset-0"
        onPointerMissed={() => setActiveQuake(null)} 
      >
        <ambientLight intensity={1.5} />
        <directionalLight position={[5, 3, 5]} intensity={3.5} castShadow />
        <hemisphereLight skyColor="#ffffff" groundColor="#001144" intensity={1.0} />

        <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
        <OrbitControls enablePan={false} enableZoom={true} minDistance={2.5} maxDistance={10} />
        
        <group rotation={[0.41, 0, 0]}>
          <React.Suspense fallback={<mesh><sphereGeometry args={[GLOBE_RADIUS, 16, 16]} /><meshBasicMaterial color="gray" wireframe /></mesh>}>
            <Globe />
          </React.Suspense>
          <TectonicPlates />
          {earthquakeData.map((quake) => (
            <QuakeRipple key={quake.id} quake={quake} activeQuake={activeQuake} setActiveQuake={setActiveQuake} />
          ))}
        </group>
        <CameraRig activeQuake={activeQuake} />
      </Canvas>
    </div>
  );
}