import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import GLOBE from 'vanta/dist/vanta.globe.min'

// A small glowing wireframe globe used as a decorative hero accent — a
// "premium SaaS hero visual" rather than a full-bleed pattern. Sized by
// its container; never mounts for reduced-motion users.
export default function VantaGlobe({ className }) {
  const hostRef = useRef(null)
  const effectRef = useRef(null)
  const [enabled] = useState(
    () => typeof window !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )

  useEffect(() => {
    if (!enabled || !hostRef.current || effectRef.current) return
    effectRef.current = GLOBE({
      el: hostRef.current,
      THREE,
      mouseControls: true,
      touchControls: false,
      gyroControls: false,
      minHeight: 200.0,
      minWidth: 200.0,
      scale: 1.0,
      scaleMobile: 1.0,
      color: 0xd8672e,
      color2: 0xe2a154,
      backgroundColor: 0x0,
      backgroundAlpha: 0,
      size: 1.1
    })
    return () => {
      effectRef.current?.destroy()
      effectRef.current = null
    }
  }, [enabled])

  if (!enabled) return null
  return <div ref={hostRef} aria-hidden="true" className={className} />
}
