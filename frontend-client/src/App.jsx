import React, { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls, Stars, Html } from '@react-three/drei';
import * as THREE from 'three';

// --- CONFIGURATION ---
const WS_URL = 'ws://localhost:8080';
const GLOBE_RADIUS = 2; 

const TEXTURES = {
  satellite: 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg',
  topography: 'https://unpkg.com/three-globe/example/img/earth-day.jpg',
  dark: 'https://unpkg.com/three-globe/example/img/earth-dark.jpg',
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

// --- UTILS & MATH VAULT ---
const latLongToVector3 = (lat, lng, radius, depthKm = 0) => {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  const actualRadius = radius - (depthKm * 0.001); 
  const x = -(actualRadius * Math.sin(phi) * Math.cos(theta));
  const z = (actualRadius * Math.sin(phi) * Math.sin(theta));
  const y = (actualRadius * Math.cos(phi));
  return new THREE.Vector3(x, y, z);
};

const calculateHaversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; 
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
    return () => { camera.clearViewOffset(); };
  }, [camera, size]);
  return null;
};

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

const Globe = ({ mapType }) => {
  const [satMap, topoMap, darkMap, normalMap, waterMap, cloudMap] = useLoader(THREE.TextureLoader, [
    TEXTURES.satellite, TEXTURES.topography, TEXTURES.dark, TEXTURES.normal, TEXTURES.water, TEXTURES.clouds
  ]);
  const cloudsRef = useRef();

  useFrame(() => { if (cloudsRef.current) cloudsRef.current.rotation.y += 0.00005; });

  const activeMap = mapType === 'topography' ? topoMap : mapType === 'dark' ? darkMap : satMap;
  const isLightMap = mapType === 'topography' || mapType === 'terrain';

  // The custom GLSL shader that paints the "clay" geometry into a green/blue map on the fly
  const terrainShader = useMemo(() => {
    return (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        `#include <map_fragment>`,
        `
        #ifdef USE_MAP
          // We passed 'waterMap' as the base map, so the red channel tells us what is water (1.0) and what is land (0.0)
          float isWater = texture2D( map, vUv ).r;
          
          // The custom colors from your screenshot
          vec3 land = vec3(0.82, 0.92, 0.82);   // Pale mint green
          vec3 water = vec3(0.65, 0.85, 1.00);  // Bright sky blue
          
          vec4 texelColor = vec4(mix(land, water, isWater), 1.0);
          diffuseColor *= texelColor;
        #endif
        `
      );
    };
  }, []);

  return (
    <group>
      <mesh receiveShadow castShadow>
        <sphereGeometry args={[GLOBE_RADIUS, 64, 64]} />
        {mapType === 'terrain' ? (
          <meshStandardMaterial 
            map={waterMap} 
            normalMap={normalMap} 
            roughness={0.7} 
            onBeforeCompile={terrainShader}
          />
        ) : (
          <meshPhongMaterial map={activeMap} normalMap={normalMap} specularMap={waterMap} specular={new THREE.Color('#222222')} shininess={15} />
        )}
      </mesh>
      
      {mapType === 'satellite' && (
        <mesh ref={cloudsRef} castShadow receiveShadow>
          <sphereGeometry args={[GLOBE_RADIUS + 0.006, 64, 64]} />
          <meshStandardMaterial map={cloudMap} transparent={true} opacity={0.6} depthWrite={false} />
        </mesh>
      )}

      {!isLightMap && (
        <mesh>
          <sphereGeometry args={[GLOBE_RADIUS * 1.15, 64, 64]} />
          <shaderMaterial vertexShader={atmosphereVertexShader} fragmentShader={atmosphereFragmentShader} blending={THREE.AdditiveBlending} side={THREE.BackSide} transparent={true} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
};

const TectonicPlates = ({ targetCoords, mapType }) => {
  const [plateLines, setPlateLines] = useState([]);
  
  useEffect(() => {
    fetch(TECTONIC_PLATES_URL).then(res => res.json()).then(data => {
      setPlateLines(data.features.map(f => f.geometry.coordinates.map(c => latLongToVector3(c[1], c[0], GLOBE_RADIUS + 0.002))));
    }).catch(e => console.error(e));
  }, []);

  const targetVec = useMemo(() => {
    if (!targetCoords) return null;
    return latLongToVector3(targetCoords.lat, targetCoords.lng, GLOBE_RADIUS);
  }, [targetCoords]);

  const isLightMap = mapType === 'topography' || mapType === 'terrain';

  return (
    <group>
      {plateLines.map((points, i) => {
        let isHighlighted = false;
        if (targetVec && points.length > 0) {
          isHighlighted = points[0].distanceTo(targetVec) < 1.0;
        }
        
        const lineColor = isHighlighted 
            ? (isLightMap ? '#0284c7' : '#00ffff') 
            : (isLightMap ? '#b45309' : '#ff6600'); 
            
        const lineOpacity = isHighlighted ? 1.0 : (targetVec ? 0.15 : (isLightMap ? 0.9 : 0.6)); 

        return (
          <line key={i} geometry={new THREE.BufferGeometry().setFromPoints(points)}>
            <lineBasicMaterial 
              color={lineColor} 
              transparent={true} 
              opacity={lineOpacity} 
              blending={isLightMap ? THREE.NormalBlending : THREE.AdditiveBlending} 
            />
          </line>
        )
      })}
    </group>
  );
};

const RegionalReticle = ({ targetCoords, mapType }) => {
  const meshRef = useRef();
  const isLightMap = mapType === 'topography' || mapType === 'terrain';
  
  const pos = useMemo(() => {
    if (!targetCoords) return null;
    return latLongToVector3(targetCoords.lat, targetCoords.lng, GLOBE_RADIUS + 0.01);
  }, [targetCoords]);

  useFrame((state) => {
    if (!meshRef.current) return;
    const scale = 1.0 + Math.sin(state.clock.elapsedTime * 4) * 0.2;
    meshRef.current.scale.set(scale, scale, 1);
  });

  if (!pos) return null;

  const reticleColor = isLightMap ? '#0284c7' : '#00ffff';
  const blendMode = isLightMap ? THREE.NormalBlending : THREE.AdditiveBlending;

  return (
    <group position={pos} onUpdate={self => self.lookAt(0,0,0)}>
      <mesh ref={meshRef}>
        <ringGeometry args={[0.2, 0.22, 32]} />
        <meshBasicMaterial color={reticleColor} side={THREE.DoubleSide} transparent opacity={0.8} blending={blendMode} depthWrite={false} />
      </mesh>
      <mesh>
        <circleGeometry args={[0.02, 16]} />
        <meshBasicMaterial color={reticleColor} transparent opacity={0.8} blending={blendMode} depthWrite={false}/>
      </mesh>
    </group>
  );
}

const ShockwaveDome = ({ impactRadiusKm, colorStr, mapType }) => {
  const domeRef = useRef();
  const scale3D = useMemo(() => (impactRadiusKm / 6371) * GLOBE_RADIUS, [impactRadiusKm]);
  const isLightMap = mapType === 'topography' || mapType === 'terrain';
  const blendMode = isLightMap ? THREE.NormalBlending : THREE.AdditiveBlending;

  useFrame((state) => {
    if(!domeRef.current) return;
    const pulse = 1.0 + Math.sin(state.clock.elapsedTime * 5) * 0.05;
    domeRef.current.scale.lerp(new THREE.Vector3(scale3D * pulse, scale3D * pulse, scale3D * 0.4 * pulse), 0.1);
  });

  return (
    <mesh ref={domeRef} position={[0,0,0.005]}>
       <sphereGeometry args={[1, 32, 32]} />
       <meshBasicMaterial color={colorStr} transparent opacity={isLightMap ? 0.3 : 0.15} blending={blendMode} depthWrite={false} />
       <meshBasicMaterial color={colorStr} wireframe transparent opacity={isLightMap ? 0.6 : 0.3} blending={blendMode} depthWrite={false} />
    </mesh>
  )
};

const QuakeRipple = ({ quake, activeQuake, triggerQuakeSelect, userLocation, mapType }) => {
  const meshRef = useRef();
  const materialRef = useRef();
  const tsunamiRef = useRef();
  const tsunamiMatRef = useRef();
  const [hovered, setHovered] = useState(false);
  
  const { latitude, longitude, depth } = quake.coordinates;
  const mag = quake.magnitude;
  const isActive = activeQuake?.id === quake.id;
  const hasTsunami = quake.tsunami === 1; 
  const isLightMap = mapType === 'topography' || mapType === 'terrain';
  
  const pos = useMemo(() => latLongToVector3(latitude, longitude, GLOBE_RADIUS + 0.008), [latitude, longitude]);
  const baseScale = useMemo(() => Math.max(0.08, mag * 0.04), [mag]);
  
  const rippleColorStr = useMemo(() => {
    if (isLightMap) return mag > 5 ? '#dc2626' : mag > 3 ? '#ea580c' : '#2563eb';
    return mag > 5 ? '#ff0000' : mag > 3 ? '#ffaa00' : '#3b82f6';
  }, [mag, isLightMap]);

  const uniforms = useMemo(() => ({ uColor: { value: new THREE.Color(rippleColorStr) }, time: { value: 0 } }), [rippleColorStr]);
  const timeOffset = useMemo(() => Math.random() * 5, []);

  const impactRadiusKm = useMemo(() => {
    const baseEnergy = Math.exp(mag) / 4; 
    const depthPenalty = Math.max(0.05, 1 - (depth / 300));
    return Math.round(Math.min(baseEnergy * depthPenalty, 3000));
  }, [mag, depth]);

  const getDynamicColorClass = (magnitude, isTsunami, type) => {
    if (isTsunami) return type === 'border' ? 'border-fuchsia-500 shadow-[0_0_20px_rgba(255,0,255,0.4)]' : 'text-fuchsia-500';
    if (magnitude > 5) return type === 'border' ? 'border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.4)]' : 'text-red-500';
    if (magnitude > 3) return type === 'border' ? 'border-orange-500 shadow-[0_0_20px_rgba(249,115,22,0.4)]' : 'text-orange-500';
    return type === 'border' ? 'border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.3)]' : 'text-blue-500';
  };

  const tetherGeom = useMemo(() => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-1.8)]), []);
  const blendMode = isLightMap ? THREE.NormalBlending : THREE.AdditiveBlending;

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
        tsunamiMatRef.current.opacity = (1.0 - tProgress) * (isLightMap ? 0.8 : 0.6); 
    }
  });

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
        <shaderMaterial ref={materialRef} vertexShader={rippleVertexShader} fragmentShader={rippleFragmentShader} uniforms={uniforms} transparent={true} blending={blendMode} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {isActive && <ShockwaveDome impactRadiusKm={impactRadiusKm} colorStr={rippleColorStr} mapType={mapType} />}

      {hasTsunami && (
        <mesh ref={tsunamiRef} position={[0,0,-0.001]}> 
          <ringGeometry args={[0.8, 1, 64]} />
          <meshBasicMaterial ref={tsunamiMatRef} color="#a21caf" side={THREE.DoubleSide} transparent={true} blending={blendMode} depthWrite={false} />
        </mesh>
      )}

      {isActive && (
        <>
          <line geometry={tetherGeom}><lineBasicMaterial color={rippleColorStr} transparent={true} opacity={isLightMap ? 0.9 : 0.6} blending={blendMode} /></line>
          
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

                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div className="bg-slate-800/50 border border-slate-700 p-2 rounded text-center">
                    <span className="text-slate-400 font-mono text-[9px] block uppercase tracking-widest">Impact Zone</span>
                    <span className="text-white font-bold font-mono tracking-widest text-xs">{impactRadiusKm.toLocaleString()} km</span>
                  </div>
                  {distanceToUser && (
                    <div className="bg-slate-800/50 border border-slate-700 p-2 rounded text-center">
                      <span className="text-slate-400 font-mono text-[9px] block uppercase tracking-widest">Distance To You</span>
                      <span className="text-white font-bold font-mono tracking-widest text-xs">{distanceToUser.toLocaleString()} km</span>
                    </div>
                  )}
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
  const [cameraTarget, setCameraTarget] = useState(null); 
  const [activeRegion, setActiveRegion] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  
  const [mapType, setMapType] = useState('satellite'); 
  const [filterMode, setFilterMode] = useState('ALL');
  
  const [sortMode, setSortMode] = useState('MAGNITUDE'); 
  const [playbackTime, setPlaybackTime] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const wsRef = useRef(null); 

  useEffect(() => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => console.warn("User denied GPS access.")
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
          const data = JSON.parse(event.data);
          setLastJsonMessage(data);
          if (data.events && data.events.length > 0 && !isPlaying) {
             setPlaybackTime(Math.max(...data.events.map(q => q.time)));
          }
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
  }, [isPlaying]);

  const changeTimeframe = (frame) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ command: 'change_timeframe', value: frame }));
      setFilterMode('ALL'); 
      setIsPlaying(false);
    }
  };

  const triggerQuakeSelect = (quake) => {
    setActiveQuake(quake);
    setActiveRegion(null); 
    if (quake) {
      setCameraTarget({ lat: quake.coordinates.latitude, lng: quake.coordinates.longitude });
    }
  };

  const triggerRegionalJump = (region) => {
    setActiveQuake(null); 
    setActiveRegion(region); 
    setCameraTarget({ lat: region.lat, lng: region.lng }); 
  };

  const earthquakeData = lastJsonMessage?.events || [];
  const currentTimeframe = lastJsonMessage?.timeframe || 'hour'; 

  useEffect(() => {
    let interval;
    if (isPlaying && earthquakeData.length > 0) {
        const minTime = Math.min(...earthquakeData.map(q => q.time));
        const maxTime = Math.max(...earthquakeData.map(q => q.time));
        const step = (maxTime - minTime) / 300; 
        
        if (playbackTime >= maxTime) setPlaybackTime(minTime);

        interval = setInterval(() => {
            setPlaybackTime(prev => {
                if (prev >= maxTime) { setIsPlaying(false); return maxTime; }
                return prev + step;
            });
        }, 30);
    }
    return () => clearInterval(interval);
  }, [isPlaying, earthquakeData]);

  const visibleQuakes = useMemo(() => {
    let filtered = earthquakeData;
    if (playbackTime) filtered = filtered.filter(q => q.time <= playbackTime);
    if (filterMode === 'TSUNAMI') return filtered.filter(q => q.tsunami === 1);
    if (filterMode === '5.0') return filtered.filter(q => q.magnitude >= 5.0);
    if (filterMode === '3.0') return filtered.filter(q => q.magnitude >= 3.0);
    return filtered; 
  }, [earthquakeData, filterMode, playbackTime]);

  const topQuakes = useMemo(() => {
    let sorted = [...visibleQuakes];
    if (sortMode === 'MAGNITUDE') {
        sorted.sort((a, b) => b.magnitude - a.magnitude);
    } else if (sortMode === 'RECENT') {
        sorted.sort((a, b) => b.time - a.time);
    } else if (sortMode === 'PROXIMITY' && userLocation) {
        sorted.sort((a, b) => {
            const distA = calculateHaversineDistance(userLocation.lat, userLocation.lng, a.coordinates.latitude, a.coordinates.longitude);
            const distB = calculateHaversineDistance(userLocation.lat, userLocation.lng, b.coordinates.latitude, b.coordinates.longitude);
            return distA - distB;
        });
    }
    return sorted.slice(0, 10);
  }, [visibleQuakes, sortMode, userLocation]);

  const connectionStatus = { 0: 'CONNECTING...', 1: 'LIVE DATA STREAM OPEN', 2: 'DISCONNECTING...', 3: 'OFFLINE - RETRYING...' }[readyState];
  
  const minTime = earthquakeData.length > 0 ? Math.min(...earthquakeData.map(q => q.time)) : 0;
  const maxTime = earthquakeData.length > 0 ? Math.max(...earthquakeData.map(q => q.time)) : 100;
  const scrubberProgress = playbackTime ? ((playbackTime - minTime) / (maxTime - minTime)) * 100 : 100;

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative font-sans text-white m-0 p-0 flex">
      
      {/* --- HUD OVERLAY (LEFT) --- */}
      {/* 
        FIX: Added Tailwind classes to hide the scrollbar across all browsers:
        [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] 
      */}
      <div className="absolute inset-y-0 left-0 z-10 p-8 flex flex-col justify-between max-h-screen overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] pointer-events-none">
        <div className="pointer-events-auto">
          <h1 className="text-5xl font-black text-blue-500 tracking-tight drop-shadow-md mb-4">SEISMIC</h1>
          <div className="bg-slate-900/80 border border-slate-700 p-4 rounded-lg backdrop-blur-md space-y-2 inline-block shadow-lg">
            <p className="text-sm text-slate-300 font-mono">STATUS: <span className={readyState === 1 ? 'text-blue-500 font-bold' : 'text-red-500 font-bold'}>[{connectionStatus}]</span></p>
            <p className="text-sm text-slate-300 font-mono">TOTAL IN CACHE: <span className="text-white font-bold">{earthquakeData.length}</span></p>
            <p className="text-sm text-slate-300 font-mono">VISIBLE: <span className="text-blue-500 font-bold">{visibleQuakes.length}</span></p>
            <p className="text-sm text-slate-300 font-mono">LAST SYNC: <span className="text-white font-bold">{formatUTCTime(lastJsonMessage?.timestamp)}</span></p>
            {userLocation && <p className="text-[10px] text-green-500 font-mono mt-2 uppercase tracking-widest pt-2 border-t border-slate-700">GPS PROXIMITY LINK ACTIVE</p>}
          </div>
        </div>

        <div className="space-y-4 pointer-events-auto inline-block w-max mt-4">
          
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

            <div className="mt-4 pt-3 border-t border-slate-700">
               <h3 className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-2">Tactical Overrides</h3>
               <div className="grid grid-cols-2 gap-1">
                  {REGIONAL_JUMPS.map(region => (
                    <button 
                      key={region.name}
                      onClick={() => triggerRegionalJump(region)}
                      className={`py-1.5 px-2 text-[10px] font-bold uppercase tracking-widest rounded transition-colors ${
                        activeRegion?.name === region.name 
                          ? 'bg-cyan-900/50 border border-cyan-400 text-cyan-300' 
                          : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-blue-900/30 hover:border-blue-500 hover:text-blue-300'
                      }`}
                    >
                      {region.name}
                    </button>
                  ))}
               </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-700">
               <h3 className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-2">Map Interface</h3>
               {/* FIX 2: Removed the 4 map options, reduced to 2 (Satellite and Topography) */}
               <div className="grid grid-cols-2 gap-1">
                 <button onClick={() => setMapType('satellite')} className={`py-1.5 px-2 text-[10px] uppercase tracking-widest font-bold rounded border transition-colors ${mapType === 'satellite' ? 'bg-slate-200 border-white text-slate-900' : 'bg-transparent border-slate-700 text-slate-500 hover:text-slate-300'}`}>Satellite</button>
                 <button onClick={() => setMapType('topography')} className={`py-1.5 px-2 text-[10px] uppercase tracking-widest font-bold rounded border transition-colors ${mapType === 'topography' ? 'bg-slate-200 border-white text-slate-900' : 'bg-transparent border-slate-700 text-slate-500 hover:text-slate-300'}`}>Topography</button>
               </div>
            </div>

          </div>
        </div>
      </div>

      {/* --- TEMPORAL TIMELINE SCRUBBER (BOTTOM) --- */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 pointer-events-auto">
         <div className="bg-slate-900/90 border border-slate-700 p-4 rounded-xl backdrop-blur-md shadow-2xl flex items-center space-x-6 w-[600px]">
            <button 
              onClick={() => setIsPlaying(!isPlaying)}
              className="w-12 h-12 rounded-full border-2 border-blue-500 flex items-center justify-center text-blue-400 hover:bg-blue-900/50 hover:text-white hover:border-white transition-all focus:outline-none"
            >
              {isPlaying ? <span className="block w-4 h-4 bg-current"></span> : <span className="block w-0 h-0 border-y-8 border-y-transparent border-l-[14px] border-l-current ml-1"></span>}
            </button>
            <div className="flex-1">
              <div className="flex justify-between items-end mb-2">
                 <span className="text-[10px] text-slate-400 font-bold tracking-widest uppercase">Temporal Timeline</span>
                 <span className="text-xs font-mono font-bold text-white">{formatUTCTime(playbackTime)}</span>
              </div>
              <div className="relative w-full h-2 bg-slate-800 rounded-full cursor-pointer"
                   onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const ratio = (e.clientX - rect.left) / rect.width;
                      setPlaybackTime(minTime + (ratio * (maxTime - minTime)));
                      setIsPlaying(false);
                   }}>
                 <div className="absolute top-0 left-0 h-full bg-blue-500 rounded-full" style={{ width: `${Math.max(0, Math.min(100, scrubberProgress))}%` }}></div>
                 <div className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-blue-500 rounded-full shadow-[0_0_10px_rgba(59,130,246,0.8)]" style={{ left: `calc(${Math.max(0, Math.min(100, scrubberProgress))}% - 8px)` }}></div>
              </div>
            </div>
         </div>
      </div>

      {/* --- SIDEBAR PANEL (RIGHT) --- */}
      <div className="absolute inset-y-0 right-0 w-96 bg-slate-900 border-l border-slate-700 shadow-2xl z-10 flex flex-col pointer-events-auto">
        <div className="p-6 border-b border-slate-700 bg-slate-800">
          <h2 className="text-white font-black tracking-wide text-xl uppercase mb-3">Priority Targets</h2>
          
          <div className="flex space-x-1 mb-2">
            <button onClick={() => setSortMode('MAGNITUDE')} className={`flex-1 py-1.5 px-2 text-[9px] uppercase tracking-widest font-bold rounded border transition-colors ${sortMode === 'MAGNITUDE' ? 'bg-blue-600/30 border-blue-500 text-blue-300' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300'}`}>Magnitude</button>
            <button onClick={() => setSortMode('RECENT')} className={`flex-1 py-1.5 px-2 text-[9px] uppercase tracking-widest font-bold rounded border transition-colors ${sortMode === 'RECENT' ? 'bg-blue-600/30 border-blue-500 text-blue-300' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300'}`}>Recent</button>
            <button onClick={() => setSortMode('PROXIMITY')} disabled={!userLocation} className={`flex-1 py-1.5 px-2 text-[9px] uppercase tracking-widest font-bold rounded border transition-colors ${!userLocation ? 'opacity-50 cursor-not-allowed' : sortMode === 'PROXIMITY' ? 'bg-blue-600/30 border-blue-500 text-blue-300' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300'}`}>Proximity</button>
          </div>
        </div>
        
        {/* FIX: Applied the same invisible scrollbar fix to the right sidebar */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
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

            const dist = userLocation ? calculateHaversineDistance(userLocation.lat, userLocation.lng, quake.coordinates.latitude, quake.coordinates.longitude) : null;

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
                  <span className="text-[10px] text-slate-400 font-mono bg-slate-900 px-2 py-1 rounded border border-slate-700">{formatUTCTime(quake.time).split(' ')[1]}</span>
                </div>
                <p className="text-sm text-slate-300 font-medium whitespace-normal leading-snug">{quake.place}</p>
                
                <div className="mt-3 flex items-center justify-between">
                  {quake.tsunami === 1 ? (
                    <div className="text-[9px] text-white bg-fuchsia-600 px-1.5 py-0.5 inline-block font-bold rounded uppercase tracking-wider">Tsunami Risk</div>
                  ) : <div></div>}
                  
                  {dist && sortMode === 'PROXIMITY' && (
                     <div className="text-[10px] text-green-400 font-mono font-bold">{dist.toLocaleString()} km away</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* --- 3D CANVAS --- */}
      <Canvas camera={{ position: [0, 0, 6], fov: 60 }} className="block w-full h-full absolute inset-0 z-0" onPointerMissed={() => triggerQuakeSelect(null)}>
        <ViewportAdjuster />

        <ambientLight intensity={mapType === 'terrain' || mapType === 'topography' ? 0.6 : 1.5} />
        <directionalLight position={[5, 3, 5]} intensity={mapType === 'terrain' || mapType === 'topography' ? 1.2 : 3.5} castShadow />
        
        {/* Only show stars if not in a light mode */}
        {(mapType !== 'terrain' && mapType !== 'topography') && <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />}
        
        <OrbitControls enablePan={false} enableZoom={true} minDistance={2.5} maxDistance={10} />
        
        <group rotation={[0.41, 0, 0]}>
          <React.Suspense fallback={<mesh><sphereGeometry args={[GLOBE_RADIUS, 16, 16]} /><meshBasicMaterial color="gray" wireframe /></mesh>}>
            <Globe mapType={mapType} />
          </React.Suspense>
          
          <TectonicPlates targetCoords={activeRegion} mapType={mapType} />
          {activeRegion && <RegionalReticle targetCoords={activeRegion} mapType={mapType} />}

          {visibleQuakes.map((quake) => (
            <QuakeRipple key={quake.id} quake={quake} activeQuake={activeQuake} triggerQuakeSelect={triggerQuakeSelect} userLocation={userLocation} mapType={mapType} />
          ))}
        </group>
        <CameraRig targetCoords={cameraTarget} />
      </Canvas>
    </div>
  );
}