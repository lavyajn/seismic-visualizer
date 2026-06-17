import React, { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls, Stars, Html } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';

// --- CONFIGURATION ---
const WS_URL = 'ws://localhost:8080';
const GLOBE_RADIUS = 2; 

const TEXTURES = {
  color: 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg',
  normal: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_normal_2048.jpg',
  water: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_specular_2048.jpg',
  clouds: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_clouds_1024.png'
};

const TECTONIC_PLATES_URL = 'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json';

// --- GLSL SHADERS ---
const atmosphereVertexShader = ` varying vec3 vNormal; void main() { vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); } `;
const atmosphereFragmentShader = ` varying vec3 vNormal; void main() { float intensity = pow(0.65 - dot(vNormal, vec3(0, 0, 1.0)), 4.0); gl_FragColor = vec4(0.3, 0.6, 1.0, 1.0) * intensity; } `;
const rippleVertexShader = ` varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); } `;
const rippleFragmentShader = `
  uniform vec3 uColor; uniform float time; varying vec2 vUv;
  void main() {
    float dist = distance(vUv, vec2(0.5));
    if (dist > 0.5) discard;
    float wave = sin((dist * 30.0) - (time * 5.0));
    wave = smoothstep(0.6, 1.0, wave);
    float edgeFade = smoothstep(0.5, 0.2, dist) * smoothstep(0.0, 0.1, dist);
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

// Haversine Formula for spherical distance calculation
const calculateHaversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return Math.round(R * c);
};

const formatUTCTime = (timestamp) => {
  if (!timestamp) return 'WAITING...';
  return new Date(timestamp).toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' UTC';
};

// --- HOT ZONES ---
const REGIONAL_JUMPS = [
  { name: 'RING OF FIRE', lat: 35.0, lng: 140.0 },
  { name: 'SAN ANDREAS', lat: 36.0, lng: -120.0 },
  { name: 'HIMALAYAS', lat: 28.0, lng: 84.0 },
  { name: 'MID-ATLANTIC', lat: 0.0, lng: -30.0 }
];

// --- COMPONENTS ---

const ViewportAdjuster = () => {
  const { camera, size } = useThree();
  useEffect(() => {
    const rightSidebarWidth = 100; 
    camera.setViewOffset(size.width, size.height, rightSidebarWidth / 2, 0, size.width, size.height);
    camera.updateProjectionMatrix();
    return () => camera.clearViewOffset();
  }, [camera, size]);
  return null;
};

// Refactored to accept raw coordinates instead of a quake object
const CameraRig = ({ targetCoords }) => {
  const { camera } = useThree();
  const targetPos = useRef(new THREE.Vector3(0, 0, 6)); 
  const isFlying = useRef(false);

  useEffect(() => {
    if (targetCoords) {
      const surfacePos = latLongToVector3(targetCoords.lat, targetCoords.lng, GLOBE_RADIUS);
      targetPos.current.copy(surfacePos).normalize().multiplyScalar(5.5);
      isFlying.current = true;
    }
  }, [targetCoords]);

  useFrame(() => {
    if (isFlying.current) {
      camera.position.lerp(targetPos.current, 0.015);
      if (camera.position.distanceTo(targetPos.current) < 0.1) isFlying.current = false;
    }
  });
  return null;
};

const Globe = () => {
  const [colorMap, normalMap, waterMap, cloudMap] = useLoader(THREE.TextureLoader, [TEXTURES.color, TEXTURES.normal, TEXTURES.water, TEXTURES.clouds]);
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
        <meshStandardMaterial map={cloudMap} transparent={true} opacity={0.6} depthWrite={false} />
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
    fetch(TECTONIC_PLATES_URL).then(res => res.json()).then(data => {
      setPlateLines(data.features.map(f => f.geometry.coordinates.map(c => latLongToVector3(c[1], c[0], GLOBE_RADIUS + 0.002))));
    }).catch(e => console.error(e));
  }, []);
  return (
    <group>
      {plateLines.map((points, i) => (
        <line key={i} geometry={new THREE.BufferGeometry().setFromPoints(points)}>
          <lineBasicMaterial color="#ff6600" transparent={true} opacity={0.8} blending={THREE.AdditiveBlending} />
        </line>
      ))}
    </group>
  );
};

const QuakeRipple = ({ quake, activeQuake, triggerQuakeSelect, userLocation }) => {
  const meshRef = useRef();
  const materialRef = useRef();
  const tsunamiRef = useRef();
  const tsunamiMatRef = useRef();
  const [hovered, setHovered] = useState(false);
  
  const { latitude, longitude, depth } = quake.coordinates;
  const mag = quake.magnitude;
  const isActive = activeQuake?.id === quake.id;
  const hasTsunami = quake.tsunami === 1; 
  
  const pos = useMemo(() => latLongToVector3(latitude, longitude, GLOBE_RADIUS + 0.008), [latitude, longitude]);
  const baseScale = useMemo(() => Math.max(0.08, mag * 0.04), [mag]);
  
  const rippleColorStr = useMemo(() => mag > 5 ? '#ff0000' : mag > 3 ? '#ffaa00' : '#3b82f6', [mag]);
  const uniforms = useMemo(() => ({ uColor: { value: new THREE.Color(rippleColorStr) }, time: { value: 0 } }), [rippleColorStr]);
  const timeOffset = useMemo(() => Math.random() * 5, []);

  const getDynamicColorClass = (magnitude, isTsunami, type) => {
    if (isTsunami) return type === 'border' ? 'border-fuchsia-500 shadow-[0_0_20px_rgba(255,0,255,0.4)]' : 'text-fuchsia-500';
    if (magnitude > 5) return type === 'border' ? 'border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.4)]' : 'text-red-500';
    if (magnitude > 3) return type === 'border' ? 'border-orange-500 shadow-[0_0_20px_rgba(249,115,22,0.4)]' : 'text-orange-500';
    return type === 'border' ? 'border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.3)]' : 'text-blue-500';
  };

  const tetherGeom = useMemo(() => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-1.8)]), []);

  useEffect(() => { document.body.style.cursor = hovered ? 'pointer' : 'auto'; }, [hovered]);

  useFrame((state) => {
    if (!meshRef.current || !materialRef.current) return;
    const time = state.clock.getElapsedTime();
    materialRef.current.uniforms.time.value = time;
    const targetScale = (isActive || hovered) ? baseScale * 1.5 : baseScale;
    meshRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, 1), 0.1);

    if (hasTsunami && tsunamiRef.current && tsunamiMatRef.current) {
        const tProgress = ((time + timeOffset) % 5.0) / 5.0; 
        tsunamiRef.current.scale.set(0.2 + (tProgress * 0.6), 0.2 + (tProgress * 0.6), 1);
        tsunamiMatRef.current.opacity = (1.0 - tProgress) * 0.6; 
    }
  });

  // Calculate distance if we have the user's physical GPS location
  const distanceToUser = useMemo(() => {
    if (!userLocation) return null;
    return calculateHaversineDistance(userLocation.lat, userLocation.lng, latitude, longitude);
  }, [userLocation, latitude, longitude]);

  return (
    <group position={pos} onUpdate={self => self.lookAt(0,0,0)}>
      <mesh onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }} onPointerOut={() => setHovered(false)} onClick={(e) => { e.stopPropagation(); triggerQuakeSelect(isActive ? null : quake); }}>
        <sphereGeometry args={[baseScale * 0.6, 16, 16]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      <mesh ref={meshRef}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial ref={materialRef} vertexShader={rippleVertexShader} fragmentShader={rippleFragmentShader} uniforms={uniforms} transparent={true} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {hasTsunami && (
        <mesh ref={tsunamiRef} position={[0,0,-0.001]}> 
          <ringGeometry args={[0.8, 1, 64]} />
          <meshBasicMaterial ref={tsunamiMatRef} color="#ff00ff" side={THREE.DoubleSide} transparent={true} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      )}

      {isActive && (
        <>
          <line geometry={tetherGeom}><lineBasicMaterial color={rippleColorStr} transparent={true} opacity={0.6} /></line>
          
          <Html position={[0, 0, -1.8]} center zIndexRange={[100, 0]}>
            <div style={{ animation: 'fadeIn 0.3s ease-out forwards' }} className={`bg-slate-900 border-2 ${getDynamicColorClass(mag, hasTsunami, 'border')} p-4 rounded-lg text-white text-sm font-sans min-w-[280px] pointer-events-none select-none opacity-0`}>
              <style>{`@keyframes fadeIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }`}</style>
              <div className="flex justify-between items-center mb-3 border-b border-slate-700 pb-2">
                  <span className={`${getDynamicColorClass(mag, hasTsunami, 'text')} font-bold uppercase tracking-widest text-xs`}>
                    {hasTsunami ? 'TSUNAMI WARNING' : 'EVENT LOG'}
                  </span>
                  <span className="text-slate-300 font-mono text-xs">{formatUTCTime(quake.time)}</span>
              </div>
              <div className="space-y-3">
                <p className="whitespace-normal font-medium leading-relaxed"><span className="text-slate-400 font-mono text-xs block mb-1">LOCATION</span> {quake.place}</p>
                
                <div className="grid grid-cols-2 gap-4 border-t border-slate-700 pt-3">
                    <div><span className="text-slate-400 font-mono text-xs block">LATITUDE</span><span className="font-mono">{latitude.toFixed(4)}°</span></div>
                    <div><span className="text-slate-400 font-mono text-xs block">LONGITUDE</span><span className="font-mono">{longitude.toFixed(4)}°</span></div>
                </div>
                
                <div className="grid grid-cols-2 gap-4 bg-slate-800 p-2 rounded mt-2">
                    <div><span className="text-slate-400 font-mono text-xs block">MAGNITUDE</span><span className={`text-lg font-bold ${getDynamicColorClass(mag, hasTsunami, 'text')}`}>{mag.toFixed(2)}</span></div>
                    <div><span className="text-slate-400 font-mono text-xs block">DEPTH</span><span className="text-lg font-bold text-slate-200">{depth.toFixed(1)} <span className="text-sm font-normal">km</span></span></div>
                </div>

                {/* THE PROXIMITY SENSOR (Haversine Output) */}
                {distanceToUser && (
                  <div className="mt-2 bg-slate-800/50 border border-slate-700 p-2 rounded text-center">
                    <span className="text-slate-400 font-mono text-[10px] block uppercase tracking-widest">Distance To You</span>
                    <span className="text-white font-bold font-mono tracking-widest">{distanceToUser.toLocaleString()} km</span>
                  </div>
                )}

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
  const [cameraTarget, setCameraTarget] = useState(null); // Decoupled Camera Target
  const [userLocation, setUserLocation] = useState(null);
  
  const wsRef = useRef(null); 
  const [filterMode, setFilterMode] = useState('ALL');

  // Trigger GPS locator on mount
  useEffect(() => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => console.warn("User denied GPS access. Proximity sensor disabled.")
      );
    }
  }, []);

  useEffect(() => {
    let reconnectTimeout;
    const connect = () => {
      setReadyState(0); 
      wsRef.current = new WebSocket(WS_URL);
      wsRef.current.onopen = () => setReadyState(1); 
      wsRef.current.onmessage = (event) => {
        try {
          setActiveQuake(null);
          setLastJsonMessage(JSON.parse(event.data));
        } catch (e) {
          console.error('WebSocket payload parsing failed', e);
        }
      };
      wsRef.current.onclose = () => {
        setReadyState(3); 
        reconnectTimeout = setTimeout(connect, 3000);
      };
      wsRef.current.onerror = () => wsRef.current.close();
    };

    connect();
    return () => { clearTimeout(reconnectTimeout); if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); } };
  }, []);

  const changeTimeframe = (frame) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ command: 'change_timeframe', value: frame }));
      setFilterMode('ALL'); 
    }
  };

  // Controller function to handle quakes vs regions
  const triggerQuakeSelect = (quake) => {
    setActiveQuake(quake);
    if (quake) {
      setCameraTarget({ lat: quake.coordinates.latitude, lng: quake.coordinates.longitude });
    }
  };

  const triggerRegionalJump = (region) => {
    setActiveQuake(null); // Clear the HUD
    setCameraTarget({ lat: region.lat, lng: region.lng }); // Fly the drone
  };

  const earthquakeData = lastJsonMessage?.events || [];
  const currentTimeframe = lastJsonMessage?.timeframe || 'hour'; 

  const visibleQuakes = useMemo(() => {
    if (filterMode === 'TSUNAMI') return earthquakeData.filter(q => q.tsunami === 1);
    if (filterMode === '5.0') return earthquakeData.filter(q => q.magnitude >= 5.0);
    if (filterMode === '3.0') return earthquakeData.filter(q => q.magnitude >= 3.0);
    return earthquakeData; 
  }, [earthquakeData, filterMode]);

  const topQuakes = useMemo(() => {
    return [...visibleQuakes].sort((a, b) => b.magnitude - a.magnitude).slice(0, 10);
  }, [visibleQuakes]);

  const connectionStatus = { 0: 'CONNECTING...', 1: 'LIVE DATA STREAM OPEN', 2: 'DISCONNECTING...', 3: 'OFFLINE - RETRYING...' }[readyState];

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative font-sans text-white m-0 p-0 flex">
      
      {/* --- HUD OVERLAY (LEFT) --- */}
      <div className="absolute inset-y-0 left-0 pointer-events-none z-10 p-8 flex flex-col justify-between">
        <div>
          <h1 className="text-5xl font-black text-blue-500 tracking-tight drop-shadow-md mb-4">SEISMIC</h1>
          <div className="bg-slate-900/80 border border-slate-700 p-4 rounded-lg backdrop-blur-md space-y-2 inline-block shadow-lg">
            <p className="text-sm text-slate-300 font-mono">STATUS: <span className={readyState === 1 ? 'text-blue-500 font-bold' : 'text-red-500 font-bold'}>[{connectionStatus}]</span></p>
            <p className="text-sm text-slate-300 font-mono">TOTAL IN CACHE: <span className="text-white font-bold">{earthquakeData.length}</span></p>
            <p className="text-sm text-slate-300 font-mono">VISIBLE: <span className="text-blue-500 font-bold">{visibleQuakes.length}</span></p>
            <p className="text-sm text-slate-300 font-mono">LAST SYNC: <span className="text-white font-bold">{formatUTCTime(lastJsonMessage?.timestamp)}</span></p>
            {userLocation && <p className="text-[10px] text-green-500 font-mono mt-2 uppercase tracking-widest pt-2 border-t border-slate-700">GPS PROXIMITY LINK ACTIVE</p>}
          </div>
        </div>

        <div className="space-y-4 pointer-events-auto inline-block w-max">
          
          <div className="bg-slate-900/80 border border-slate-700 p-2 rounded-lg backdrop-blur-md flex space-x-2 shadow-lg">
            {['hour', 'day', 'week'].map((frame) => (
              <button
                key={frame}
                onClick={() => changeTimeframe(frame)}
                className={`px-4 py-2 rounded text-xs font-bold uppercase tracking-wider transition-colors ${
                  currentTimeframe === frame 
                    ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]' 
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                }`}
              >
                {frame === 'hour' ? '1 Hour' : frame === 'day' ? '24 Hours' : '7 Days'}
              </button>
            ))}
          </div>

          <div className="bg-slate-900/80 border border-slate-700 p-4 rounded-lg backdrop-blur-md shadow-lg">
            <h3 className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-3 border-b border-slate-700 pb-2">Threat Legend</h3>
            <div className="text-sm text-slate-200 space-y-3 font-medium">
              <div className="flex items-center"><div className="w-4 h-4 bg-blue-500 mr-3 rounded-full shadow-[0_0_12px_#3b82f6]"></div><span>Minor (&lt; 3.0)</span></div>
              <div className="flex items-center"><div className="w-4 h-4 bg-orange-400 mr-3 rounded-full shadow-[0_0_12px_#fb923c]"></div><span>Moderate (3.0 - 5.0)</span></div>
              <div className="flex items-center"><div className="w-4 h-4 bg-red-600 mr-3 rounded-full shadow-[0_0_12px_#dc2626]"></div><span>Severe (&gt; 5.0)</span></div>
              <div className="flex items-center pt-2"><div className="w-3 h-3 border-2 border-fuchsia-500 mr-3 rounded-full shadow-[0_0_10px_#ff00ff]"></div><span className="text-fuchsia-500 font-bold tracking-widest">TSUNAMI ALERT</span></div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-700">
               <h3 className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-2">Noise Filter (Magnitude)</h3>
               <div className="flex space-x-1">
                 <button onClick={() => setFilterMode('ALL')} className={`flex-1 py-1.5 px-2 text-xs rounded border transition-colors ${filterMode === 'ALL' ? 'bg-slate-700 border-slate-400 text-white shadow-inner' : 'bg-transparent border-slate-700 text-slate-500 hover:text-slate-300'}`}>All</button>
                 <button onClick={() => setFilterMode('3.0')} className={`flex-1 py-1.5 px-2 text-xs rounded border transition-colors ${filterMode === '3.0' ? 'bg-slate-700 border-slate-400 text-white shadow-inner' : 'bg-transparent border-slate-700 text-slate-500 hover:text-slate-300'}`}>3.0+</button>
                 <button onClick={() => setFilterMode('5.0')} className={`flex-1 py-1.5 px-2 text-xs rounded border transition-colors ${filterMode === '5.0' ? 'bg-slate-700 border-slate-400 text-white shadow-inner' : 'bg-transparent border-slate-700 text-slate-500 hover:text-slate-300'}`}>5.0+</button>
                 <button onClick={() => setFilterMode('TSUNAMI')} className={`flex-1 py-1.5 px-2 text-xs font-bold rounded border transition-colors ${filterMode === 'TSUNAMI' ? 'bg-fuchsia-600/30 border-fuchsia-500 text-fuchsia-300 shadow-[0_0_10px_rgba(255,0,255,0.2)]' : 'bg-transparent border-slate-700 text-fuchsia-500/50 hover:text-fuchsia-400 hover:border-fuchsia-500/50'}`}>TSUNAMI</button>
               </div>
            </div>

            {/* NEW: TACTICAL REGIONAL OVERRIDES */}
            <div className="mt-4 pt-3 border-t border-slate-700">
               <h3 className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-2">Tactical Overrides</h3>
               <div className="grid grid-cols-2 gap-1">
                  {REGIONAL_JUMPS.map(region => (
                    <button 
                      key={region.name}
                      onClick={() => triggerRegionalJump(region)}
                      className="py-1.5 px-2 text-[10px] font-bold uppercase tracking-widest rounded bg-slate-800 text-slate-400 border border-slate-700 hover:bg-blue-900/30 hover:border-blue-500 hover:text-blue-300 transition-colors"
                    >
                      {region.name}
                    </button>
                  ))}
               </div>
            </div>

          </div>
        </div>
      </div>

      {/* --- SIDEBAR PANEL (RIGHT) --- */}
      <div className="absolute inset-y-0 right-0 w-96 bg-slate-900 border-l border-slate-700 shadow-2xl z-10 flex flex-col pointer-events-auto">
        <div className="p-6 border-b border-slate-700 bg-slate-800">
          <h2 className="text-white font-black tracking-wide text-xl uppercase">Priority Targets</h2>
          <p className="text-xs text-slate-400 mt-1 font-mono">Global Top 10 ({currentTimeframe === 'hour' ? '1H' : currentTimeframe === 'day' ? '24H' : '7D'})</p>
        </div>
        
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3 custom-scrollbar">
          {topQuakes.length === 0 && (
            <div className="text-slate-500 text-sm font-mono text-center pt-10">NO THREATS FOUND IN FILTER</div>
          )}
          {topQuakes.map((quake) => {
            const isQuakeActive = activeQuake?.id === quake.id;
            const sidebarBorderClass = isQuakeActive 
                ? quake.magnitude > 5 ? 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.3)] scale-[1.02]' 
                : quake.magnitude > 3 ? 'border-orange-500 shadow-[0_0_15px_rgba(249,115,22,0.3)] scale-[1.02]' 
                : 'border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.3)] scale-[1.02]'
                : 'border-slate-700 hover:border-slate-500 hover:bg-slate-800';

            return (
              <div 
                key={quake.id} 
                onClick={() => triggerQuakeSelect(quake)}
                className={`p-4 rounded-lg cursor-pointer transition-all border-2 bg-slate-800/50 ${sidebarBorderClass}`}
              >
                <div className="flex justify-between items-center mb-2">
                  <span className={`font-black text-2xl leading-none ${quake.magnitude > 5 ? 'text-red-500' : quake.magnitude > 3 ? 'text-orange-500' : 'text-blue-500'}`}>
                    {quake.magnitude.toFixed(1)}
                  </span>
                  <span className="text-xs text-slate-400 font-mono bg-slate-900 px-2 py-1 rounded border border-slate-700">{formatUTCTime(quake.time).split(' ')[0]}</span>
                </div>
                <p className="text-sm text-slate-300 font-medium whitespace-normal leading-snug">{quake.place}</p>
                {quake.tsunami === 1 && (
                  <div className="mt-2 text-[9px] text-white bg-fuchsia-600 px-1.5 py-0.5 inline-block font-bold rounded uppercase tracking-wider">
                    Tsunami Risk
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* --- 3D CANVAS --- */}
      <Canvas camera={{ position: [0, 0, 6], fov: 60 }} className="block w-full h-full absolute inset-0 z-0" onPointerMissed={() => triggerQuakeSelect(null)}>
        <ViewportAdjuster />

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
          {visibleQuakes.map((quake) => (
            <QuakeRipple key={quake.id} quake={quake} activeQuake={activeQuake} triggerQuakeSelect={triggerQuakeSelect} userLocation={userLocation} />
          ))}
        </group>
        <CameraRig targetCoords={cameraTarget} />
      </Canvas>
    </div>
  );
}