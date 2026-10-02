import React, { useEffect, useRef } from 'react';
import type { WeatherReport } from '../../lib/experience/weather';
import { loadGsap } from './motion';

interface WeatherBackdropProps {
  report: WeatherReport | null;
  reduced: boolean;
}

/** Tint layered over the looping video (below all content). Night darkens and cools every scene. */
function tintFor(report: WeatherReport | null): { color: string; opacity: number } {
  if (!report) return { color: 'rgba(0,0,0,0)', opacity: 0 };
  const night = !report.is_day;
  switch (report.condition) {
    case 'clear': return night ? { color: 'rgba(20, 30, 70, 0.42)', opacity: 1 } : { color: 'rgba(255, 170, 60, 0.16)', opacity: 1 };
    case 'clouds': return { color: night ? 'rgba(25, 30, 50, 0.4)' : 'rgba(120, 130, 150, 0.2)', opacity: 1 };
    case 'fog': return { color: night ? 'rgba(60, 65, 80, 0.4)' : 'rgba(200, 200, 205, 0.22)', opacity: 1 };
    case 'rain': return { color: night ? 'rgba(15, 25, 50, 0.45)' : 'rgba(40, 70, 110, 0.28)', opacity: 1 };
    case 'storm': return { color: 'rgba(25, 20, 55, 0.45)', opacity: 1 };
    case 'snow': return { color: night ? 'rgba(60, 75, 110, 0.35)' : 'rgba(210, 225, 245, 0.2)', opacity: 1 };
    default: return { color: 'rgba(0,0,0,0)', opacity: 0 };
  }
}

type ParticleKind = 'rain' | 'snow' | null;

function particleKind(report: WeatherReport | null): ParticleKind {
  if (!report) return null;
  if (report.condition === 'rain' || report.condition === 'storm') return 'rain';
  if (report.condition === 'snow') return 'snow';
  return null;
}

interface Particle { x: number; y: number; speed: number; size: number; drift: number; phase: number }

/**
 * Weather layer over the background video: a crossfaded tint, drifting clouds for overcast/fog,
 * and canvas rain or snow. Reduced motion keeps only the static tint.
 */
export const WeatherBackdrop: React.FC<WeatherBackdropProps> = ({ report, reduced }) => {
  const tintRef = useRef<HTMLDivElement>(null);
  const cloudsRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const kind = particleKind(report);
  const cloudy = report?.condition === 'clouds' || report?.condition === 'fog' || report?.condition === 'rain' || report?.condition === 'storm';

  // Tint + cloud crossfade.
  useEffect(() => {
    const tint = tintRef.current;
    const clouds = cloudsRef.current;
    if (!tint || !clouds) return;
    const next = tintFor(report);
    const cloudOpacity = cloudy ? (report?.condition === 'fog' ? 0.9 : 0.6) : 0;
    if (reduced) {
      tint.style.backgroundColor = next.color;
      tint.style.opacity = String(next.opacity);
      clouds.style.opacity = String(cloudOpacity);
      return;
    }
    let cancelled = false;
    void loadGsap().then(gsap => {
      if (cancelled) return;
      if (!gsap) {
        tint.style.backgroundColor = next.color;
        tint.style.opacity = String(next.opacity);
        clouds.style.opacity = String(cloudOpacity);
        return;
      }
      gsap.to(tint, { backgroundColor: next.color, opacity: next.opacity, duration: 1.6, ease: 'sine.inOut' });
      gsap.to(clouds, { opacity: cloudOpacity, duration: 2, ease: 'sine.inOut' });
    });
    return () => { cancelled = true; };
  }, [report, reduced, cloudy]);

  // Particles.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!kind || reduced) {
      canvas.style.opacity = '0';
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = 0;
    let h = 0;
    let particles: Particle[] = [];
    const heavy = report?.condition === 'storm';

    const spawn = (anywhere: boolean): Particle => ({
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : -10,
      speed: kind === 'rain' ? 9 + Math.random() * 7 : 0.6 + Math.random() * 1.1,
      size: kind === 'rain' ? 10 + Math.random() * 10 : 1.4 + Math.random() * 2.4,
      drift: kind === 'rain' ? 1.6 : 0.4 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
    });

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const density = kind === 'rain' ? (heavy ? 1 / 5200 : 1 / 8000) : 1 / 11000;
      const count = Math.min(kind === 'rain' ? 180 : 110, Math.round(w * h * density));
      particles = Array.from({ length: count }, () => spawn(true));
    };
    resize();

    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(3, (now - last) / 16.67);
      last = now;
      ctx.clearRect(0, 0, w, h);
      if (kind === 'rain') {
        ctx.strokeStyle = 'rgba(200, 220, 255, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const p of particles) {
          p.y += p.speed * dt;
          p.x += p.drift * dt;
          if (p.y > h + 20 || p.x > w + 20) Object.assign(p, spawn(false));
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.drift * 2, p.y - p.size);
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        for (const p of particles) {
          p.phase += 0.02 * dt;
          p.y += p.speed * dt;
          p.x += Math.sin(p.phase) * p.drift * dt;
          if (p.y > h + 10) Object.assign(p, spawn(false));
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      frame = window.requestAnimationFrame(tick);
    };

    const start = () => {
      window.cancelAnimationFrame(frame);
      last = performance.now();
      frame = window.requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') window.cancelAnimationFrame(frame);
      else start();
    };
    start();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    let cancelled = false;
    void loadGsap().then(gsap => {
      if (cancelled) return;
      if (gsap) gsap.to(canvas, { opacity: 1, duration: 1.2, ease: 'sine.out' });
      else canvas.style.opacity = '1';
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.style.opacity = '0';
      ctx.clearRect(0, 0, w, h);
    };
  }, [kind, reduced, report?.condition]);

  return (
    <div className="home-weather-layer" aria-hidden="true">
      <div ref={tintRef} className="home-weather-tint" />
      <div ref={cloudsRef} className="home-weather-clouds" />
      <canvas ref={canvasRef} className="home-weather-canvas" />
    </div>
  );
};
