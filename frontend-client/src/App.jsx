import React, { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
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
    hour12: false, 
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }) + ' UTC';
};

// --- COMPONENTS ---

const Globe = () => {
  const [colorMap, normalMap, waterMap, cloudMap] = useLoader(THREE.TextureLoader, [
    TEXTURES.color,
    TEXTURES.normal,
    TEXTURES.water,
    TEXTURES.clouds
  ]);
  
  const cloudsRef = useRef();

  useFrame(() => {
    if (cloudsRef.current) {
      cloudsRef.current.rotation.y += 0.00005;
    }
  });

  return (
    <group>
      <mesh receiveShadow castShadow>
        <sphereGeometry args={[GLOBE_RADIUS, 64, 64]} />
        <meshPhongMaterial 
          map={colorMap} 
          normalMap={normalMap}
          specularMap={waterMap}
          specular={new THREE.Color('#333333')}
          shininess={15}
        />
      </mesh>

      <mesh ref={cloudsRef} castShadow receiveShadow>
        <sphereGeometry args={[GLOBE_RADIUS + 0.006, 64, 64]} />
        <meshStandardMaterial 
          map={cloudMap} 
          transparent={true} 
          opacity={0.6} 
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      <mesh>
        <sphereGeometry args={[GLOBE_RADIUS * 1.15, 64, 64]} />
        <shaderMaterial 
          vertexShader={atmosphereVertexShader}
          fragmentShader={atmosphereFragmentShader}
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
          transparent={true}
          depthWrite={false}
        />
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
        const lines = [];
        data.features.forEach(feature => {
          const coords = feature.geometry.coordinates;
          const points = coords.map(c => latLongToVector3(c[1], c[0], GLOBE_RADIUS + 0.002));
          lines.push(points);
        });
        setPlateLines(lines);
      })
      .catch(err => console.error("Failed to load tectonic plates", err));
  }, []);

  return (
    <group>
      {plateLines.map((points, index) => {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        return (
          <line key={index} geometry={geometry}>
            <lineBasicMaterial color="#ff4400" transparent={true} opacity={0.3} blending={THREE.AdditiveBlending} />
          </line>
        );
      })}
    </group>
  );
};

const QuakeRipple = ({ quake, activeQuake, setActiveQuake }) => {
  const meshRef = useRef();
  const materialRef = useRef();
  const [hovered, setHovered] = useState(false);
  
  const { latitude, longitude, depth } = quake.coordinates;
  const mag = quake.magnitude;
  const isActive = activeQuake?.id === quake.id;
  
  const pos = useMemo(() => latLongToVector3(latitude, longitude, GLOBE_RADIUS + 0.008, depth), [latitude, longitude, depth]);
  
  const rippleColor = useMemo(() => {
    if (mag > 5) return '#ff0000';
    if (mag > 3) return '#ffaa00';
    return '#00ffaa';
  }, [mag]);

  const timeOffset = useMemo(() => Math.random() * 5, []);

  useEffect(() => {
    document.body.style.cursor = hovered ? 'pointer' : 'auto';
  }, [hovered]);

  useFrame((state) => {
    if (!meshRef.current || !materialRef.current) return;

    const time = state.clock.getElapsedTime();
    const loopDuration = 3.0 / Math.max(1, mag * 0.5); 
    const progress = ((time + timeOffset) % loopDuration) / loopDuration; 
    
    if (isActive || hovered) {
        const hoverScale = Math.max(0.005, mag * 0.015) * 2;
        meshRef.current.scale.set(hoverScale, hoverScale, 1);
        materialRef.current.opacity = 0.8;
    } else {
        const baseScale = Math.max(0.005, mag * 0.015);
        const currentScale = baseScale + (progress * baseScale * (mag * 3));
        meshRef.current.scale.set(currentScale, currentScale, 1);
        materialRef.current.opacity = 1.0 - Math.pow(progress, 1.5); 
    }
  });

  return (
    <group position={pos} onUpdate={self => self.lookAt(0,0,0)}>
      <mesh 
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
        onPointerOut={(e) => setHovered(false)}
        onClick={(e) => { e.stopPropagation(); setActiveQuake(quake); }}
      >
        <sphereGeometry args={[0.03, 16, 16]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      <mesh ref={meshRef}>
        <ringGeometry args={[0.7, 1, 32]} />
        <meshBasicMaterial 
          ref={materialRef}
          color={rippleColor}
          side={THREE.DoubleSide} 
          transparent={true} 
          blending={THREE.AdditiveBlending}
          depthWrite={false} 
        />
      </mesh>

      {/* REBUILT TACTICAL HUD */}
      {isActive && (
        <Html distanceFactor={8} center zIndexRange={[100, 0]}>
          <div className="bg-black/90 border border-teal-500/40 backdrop-blur-md p-3 rounded text-white text-[10px] font-mono min-w-[240px] shadow-[0_0_20px_rgba(0,0,0,0.8)] pointer-events-none select-none">
            
            {/* Header / Time */}
            <div className="flex justify-between items-center mb-2 border-b border-gray-700 pb-1">
                <span className="text-teal-400 font-bold uppercase tracking-widest text-[11px]">EVENT LOG</span>
                <span className="text-gray-400 text-[10px]">{formatUTCTime(quake.time)}</span>
            </div>
            
            {/* Body */}
            <div className="space-y-2 leading-snug">
              {/* Location wraps to new line if it's too long instead of truncating */}
              <p className="whitespace-normal"><span className="text-gray-500">LOC:</span> {quake.place}</p>
              
              {/* Coordinate Grid */}
              <div className="grid grid-cols-2 gap-2 border-t border-gray-800 pt-2 mt-1">
                  <p><span className="text-gray-500">LAT:</span> {latitude.toFixed(4)}°</p>
                  <p><span className="text-gray-500">LNG:</span> {longitude.toFixed(4)}°</p>
              </div>
              
              {/* Stats Grid */}
              <div className="grid grid-cols-2 gap-2">
                  <p><span className="text-gray-500">MAG:</span> <span className={mag > 5 ? 'text-red-500 font-bold' : mag > 3 ? 'text-orange-400 font-bold' : 'text-teal-400 font-bold'}>{mag.toFixed(2)}</span></p>
                  <p><span className="text-gray-500">DEP:</span> {depth.toFixed(1)} km</p>
              </div>
            </div>

          </div>
        </Html>
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

    return () => {
      clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onclose = null; 
        ws.close();
      }
    };
  }, []);

  const earthquakeData = lastJsonMessage?.events || [];
  const totalQuakes = lastJsonMessage?.count || 0;

  const connectionStatus = {
    0: 'CONNECTING...',
    1: 'LIVE DATA STREAM OPEN',
    2: 'DISCONNECTING...',
    3: 'OFFLINE - RETRYING...',
  }[readyState];

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative font-mono text-white m-0 p-0">
      
      {/* --- HUD OVERLAY --- */}
      <div className="absolute inset-0 pointer-events-none z-10 p-6 flex flex-col justify-between">
        <div>
          <h1 className="text-4xl font-bold text-teal-400 tracking-widest drop-shadow-md">SEISMIC.NET</h1>
          <div className="mt-2 space-y-1 text-sm font-semibold">
            <p>STATUS: <span className={readyState === 1 ? 'text-teal-400' : 'text-red-500'}>[{connectionStatus}]</span></p>
            <p>ACTIVE ANOMALIES: <span className="text-white">{totalQuakes}</span></p>
            <p className="text-gray-400">LAST SYNC: <span className="text-white">{formatUTCTime(lastJsonMessage?.timestamp)}</span></p>
            <p className="text-xs text-gray-500 tracking-wider pt-1">USGS FEED // RTX ACCEL // SAT-LINK</p>
          </div>
        </div>

        <div className="self-end text-right text-xs text-gray-400 space-y-2 pb-4 pr-4">
          <div className="flex items-center justify-end">
            <span>Mag &lt; 3.0</span>
            <div className="w-3 h-3 bg-teal-400 ml-3 rounded-full shadow-[0_0_10px_#2dd4bf]"></div>
          </div>
          <div className="flex items-center justify-end">
            <span>Mag 3.0 - 5.0</span>
            <div className="w-3 h-3 bg-orange-400 ml-3 rounded-full shadow-[0_0_10px_#fb923c]"></div>
          </div>
          <div className="flex items-center justify-end">
            <span>Mag &gt; 5.0</span>
            <div className="w-3 h-3 bg-red-600 ml-3 rounded-full shadow-[0_0_10px_#dc2626]"></div>
          </div>
        </div>
      </div>

      {/* --- 3D CANVAS --- */}
      <Canvas 
        camera={{ position: [0, 0, 6], fov: 60 }} 
        className="block w-full h-full"
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
            <QuakeRipple 
              key={quake.id} 
              quake={quake} 
              activeQuake={activeQuake}
              setActiveQuake={setActiveQuake}
            />
          ))}
        </group>
      </Canvas>
    </div>
  );
}