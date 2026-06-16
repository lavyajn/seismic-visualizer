import React, { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import * as THREE from 'three';

// --- CONFIGURATION ---
const WS_URL = 'ws://localhost:8080';
const GLOBE_RADIUS = 2; 
const MAX_QUAKES = 5000; 

const EARTH_TEXTURE_URL = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg';

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

// --- COMPONENTS ---

// 1. The Textured Planet
const Globe = () => {
  const colorMap = useLoader(THREE.TextureLoader, EARTH_TEXTURE_URL);
  
  return (
    <mesh>
      <sphereGeometry args={[GLOBE_RADIUS, 64, 64]} />
      <meshStandardMaterial map={colorMap} roughness={0.6} metalness={0.1} />
    </mesh>
  );
};

// 2. The Shockwave Swarm (No more towers)
const QuakeSwarm = ({ data }) => {
  const meshRef = useRef();
  
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  
  const quakesRef = useRef([]);

  useEffect(() => {
    if (!meshRef.current || !data) return;

    const displayCount = Math.min(data.length, MAX_QUAKES);
    meshRef.current.count = displayCount;
    quakesRef.current = [];

    data.forEach((quake, i) => {
      if (i >= MAX_QUAKES) return;

      const { latitude, longitude, depth } = quake.coordinates;
      const mag = quake.magnitude;

      // Drop the ring slightly above the crust (GLOBE_RADIUS + 0.01) so it doesn't clip into the texture
      const pos = latLongToVector3(latitude, longitude, GLOBE_RADIUS + 0.01, depth);
      
      // Base scale based on magnitude
      const scaleBase = Math.max(0.005, mag * 0.015);

      // Randomize the start time of the ripple so they don't all pulse at the exact same millisecond
      const timeOffset = Math.random() * 5;

      quakesRef.current.push({ pos, scaleBase, mag, timeOffset });

      dummy.position.copy(pos);
      dummy.lookAt(0, 0, 0);
      dummy.scale.set(scaleBase, scaleBase, 1);
      dummy.updateMatrix();
      
      meshRef.current.setMatrixAt(i, dummy.matrix);

      // Colors
      if (mag > 5) color.setHex(0xff0000); 
      else if (mag > 3) color.setHex(0xffaa00); 
      else color.setHex(0x00ffaa); 

      meshRef.current.setColorAt(i, color);
    });

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
  }, [data, dummy, color]);

  // The Animation Loop: Expanding Ripple Effect
  useFrame((state) => {
    if (!meshRef.current || quakesRef.current.length === 0) return;

    const time = state.clock.getElapsedTime();

    quakesRef.current.forEach((quake, i) => {
      dummy.position.copy(quake.pos);
      // Force it to lay flat against the crust
      dummy.lookAt(0, 0, 0);

      // We want a looping ripple. 
      // A magnitude 5 takes 2 seconds to loop. A magnitude 2 takes 1.something seconds.
      const loopDuration = 3.0 / Math.max(1, quake.mag * 0.5); 
      
      // Calculate where we are in the current loop (0.0 to 1.0)
      const progress = ((time + quake.timeOffset) % loopDuration) / loopDuration; 

      // Scale outward based on progress. Bigger quakes have a larger max radius.
      const currentScale = quake.scaleBase + (progress * quake.scaleBase * (quake.mag * 3));
      
      // Scale X and Y to make the ring wider. Leave Z alone because it's a flat 2D object.
      dummy.scale.set(currentScale, currentScale, 1);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
    });

    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[null, null, MAX_QUAKES]}>
      {/* innerRadius, outerRadius, thetaSegments */}
      <ringGeometry args={[0.8, 1, 32]} />
      {/* DoubleSide ensures we can see the ring from any angle, opacity gives it a nice hologram vibe */}
      <meshBasicMaterial side={THREE.DoubleSide} transparent={true} opacity={0.6} depthWrite={false} />
    </instancedMesh>
  );
};

// 3. Main Application / UI Overlay
export default function App() {
  const [lastJsonMessage, setLastJsonMessage] = useState(null);
  const [readyState, setReadyState] = useState(0);

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

  const uiContainerStyle = {
    position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh',
    pointerEvents: 'none', overflow: 'hidden', fontFamily: 'monospace', color: 'white', zIndex: 10
  };

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', margin: 0, padding: 0 }}>
      
      {/* --- HUD OVERLAY --- */}
      <div style={uiContainerStyle}>
        <div style={{ position: 'absolute', top: '20px', left: '20px' }}>
          <h1 style={{ fontSize: '2rem', margin: 0, color: '#00ffaa', letterSpacing: '4px' }}>SEISMIC.NET</h1>
          <p style={{ margin: '5px 0', fontSize: '14px', color: readyState === 1 ? '#00ffaa' : '#ff4444' }}>
            STATUS: [{connectionStatus}]
          </p>
          <p style={{ margin: '5px 0', fontSize: '14px' }}>ACTIVE ANOMALIES: <strong>{totalQuakes}</strong></p>
          <p style={{ margin: '5px 0', fontSize: '10px', opacity: 0.5 }}>USGS FEED // RTX ACCEL // SAT-LINK</p>
        </div>

        <div style={{ position: 'absolute', bottom: '20px', right: '20px', textAlign: 'right', fontSize: '12px', color: '#888' }}>
          <div style={{ marginBottom: '5px' }}>Mag &lt; 3.0 <span style={{ display: 'inline-block', width: '10px', height: '10px', backgroundColor: '#00ffaa', marginLeft: '8px' }}></span></div>
          <div style={{ marginBottom: '5px' }}>Mag 3.0 - 5.0 <span style={{ display: 'inline-block', width: '10px', height: '10px', backgroundColor: '#ffaa00', marginLeft: '8px' }}></span></div>
          <div>Mag &gt; 5.0 <span style={{ display: 'inline-block', width: '10px', height: '10px', backgroundColor: '#ff0000', marginLeft: '8px' }}></span></div>
        </div>
      </div>

      {/* --- 3D CANVAS --- */}
      <Canvas camera={{ position: [0, 0, 6], fov: 60 }} style={{ display: 'block', width: '100%', height: '100%' }}>
        
        <ambientLight intensity={1.5} />
        <directionalLight position={[5, 3, 5]} intensity={2} />

        <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
        <OrbitControls enablePan={false} enableZoom={true} minDistance={2.5} maxDistance={10} />
        
        <group rotation={[0.41, 0, 0]}>
          <React.Suspense fallback={<mesh><sphereGeometry args={[GLOBE_RADIUS, 16, 16]} /><meshBasicMaterial color="gray" wireframe /></mesh>}>
            <Globe />
          </React.Suspense>
          <QuakeSwarm data={earthquakeData} />
        </group>
      </Canvas>
    </div>
  );
}