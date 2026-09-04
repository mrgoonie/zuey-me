import React from 'react';

interface IconProps {
  name: string;
  className?: string;
  size?: number;
}

export const BrandIcon: React.FC<IconProps> = ({ name, className = 'w-6 h-6', size }) => {
  const style = size ? { width: size, height: size } : undefined;

  switch (name.toLowerCase()) {
    case 'substack':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} style={style}>
          <path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z" fill="#FF6719" />
        </svg>
      );
    case 'topgroup':
      return (
        <div className={`flex items-center justify-center bg-black text-white font-black text-[10px] tracking-tighter rounded-full ${className}`} style={style}>
          <div className="text-center leading-none">
            <span className="text-[8px] block text-neutral-400">TOP</span>
            <span className="font-extrabold text-[9px]">GROUP</span>
          </div>
        </div>
      );
    case 'xinchao':
      return (
        <div className={`flex items-center justify-center bg-black rounded-full ${className}`} style={style}>
          <div className="text-center font-black tracking-tight leading-none text-[#F4D03F]">
            <div className="text-[7px]">XIN</div>
            <div className="text-[7px]">CHÀO</div>
          </div>
        </div>
      );
    case 'digitop':
      return (
        <div className={`flex items-center justify-center bg-black rounded-full overflow-hidden ${className}`} style={style}>
          <svg viewBox="0 0 32 32" fill="none" className="w-4/5 h-4/5">
            <circle cx="16" cy="16" r="14" stroke="#00E5FF" strokeWidth="2.5" strokeDasharray="6 4" />
            <circle cx="16" cy="16" r="8" stroke="#00E5FF" strokeWidth="2" />
            <circle cx="16" cy="16" r="3" fill="#00E5FF" />
          </svg>
        </div>
      );
    case 'nextlevel':
      return (
        <div className={`flex items-center justify-center bg-gradient-to-tr from-purple-700 to-indigo-500 text-white font-black text-[10px] rounded-full ${className}`} style={style}>
          NLB
        </div>
      );
    case 'tose':
      return (
        <div className={`flex items-center justify-center bg-sky-500 text-white font-black text-[9px] rounded-full ${className}`} style={style}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3/5 h-3/5">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="white" />
          </svg>
        </div>
      );
    case 'bipvn':
      return (
        <div className={`flex items-center justify-center bg-gradient-to-br from-indigo-900 via-purple-900 to-slate-950 text-white font-mono font-bold text-[9px] rounded-full border border-purple-500/30 ${className}`} style={style}>
          #bip
        </div>
      );
    case 'agentkit':
      return (
        <div className={`flex items-center justify-center bg-gradient-to-br from-orange-500 via-amber-600 to-red-600 text-white font-black text-[10px] rounded-full shadow-sm ${className}`} style={style}>
          AK
        </div>
      );
    case 'dewee':
      return (
        <div className={`flex items-center justify-center bg-emerald-600 text-white font-bold text-[9px] rounded-full shadow-sm ${className}`} style={style}>
          <span className="text-sm">🐾</span>
        </div>
      );
    case 'goclaw':
      return (
        <div className={`flex items-center justify-center bg-cyan-600 text-white font-bold text-[9px] rounded-full shadow-sm ${className}`} style={style}>
          <span className="text-sm">🦀</span>
        </div>
      );
    case 'indieboosting':
      return (
        <div className={`flex items-center justify-center bg-gradient-to-tr from-purple-600 to-pink-500 text-white font-bold text-[9px] rounded-full shadow-sm ${className}`} style={style}>
          <span className="text-sm">🚀</span>
        </div>
      );
    case 'uupm':
      return (
        <div className={`flex items-center justify-center bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white font-black text-[9px] rounded-full shadow-sm ${className}`} style={style}>
          ✨
        </div>
      );
    case 'agentwiki':
      return (
        <div className={`flex items-center justify-center bg-blue-600 text-white font-bold text-[9px] rounded-full shadow-sm ${className}`} style={style}>
          📖
        </div>
      );
    case 'agentbrain':
      return (
        <div className={`flex items-center justify-center bg-indigo-700 text-white font-bold text-[9px] rounded-full shadow-sm ${className}`} style={style}>
          🧠
        </div>
      );
    case 'skillx':
      return (
        <div className={`flex items-center justify-center bg-amber-500 text-white font-black text-[9px] rounded-full shadow-sm ${className}`} style={style}>
          ⚡
        </div>
      );
    case 'findyourai':
      return (
        <div className={`flex items-center justify-center bg-teal-600 text-white font-bold text-[9px] rounded-full shadow-sm ${className}`} style={style}>
          🔍
        </div>
      );
    case 'vidcap':
      return (
        <div className={`flex items-center justify-center bg-rose-500 text-white font-bold text-[9px] rounded-full shadow-sm ${className}`} style={style}>
          🎬
        </div>
      );
    case 'reviewweb':
      return (
        <div className={`flex items-center justify-center bg-emerald-700 text-white font-bold text-[9px] rounded-full shadow-sm ${className}`} style={style}>
          📊
        </div>
      );

    // Social Media Icons
    case 'x':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} style={style}>
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      );
    case 'facebook':
    case 'fb':
      return (
        <svg viewBox="0 0 24 24" fill="#1877F2" className={className} style={style}>
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
        </svg>
      );
    case 'instagram':
    case 'ig':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} style={style}>
          <rect width="24" height="24" rx="6" fill="url(#ig-grad)" />
          <path d="M12 7a5 5 0 100 10 5 5 0 000-10zm0 8.2a3.2 3.2 0 110-6.4 3.2 3.2 0 010 6.4zm5.2-8.4a1.2 1.2 0 11-2.4 0 1.2 1.2 0 012.4 0z" fill="white" />
          <defs>
            <radialGradient id="ig-grad" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(24 0 0 24 2.4 22.8)">
              <stop stopColor="#FD5" />
              <stop offset=".5" stopColor="#FF543E" />
              <stop offset="1" stopColor="#C837AB" />
            </radialGradient>
          </defs>
        </svg>
      );
    case 'tiktok':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} style={style}>
          <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.24 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
        </svg>
      );
    case 'youtube':
      return (
        <svg viewBox="0 0 24 24" fill="#FF0000" className={className} style={style}>
          <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
        </svg>
      );
    case 'threads':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} style={style}>
          <path d="M12.001 0C5.372 0 0 5.372 0 12c0 6.626 5.372 12 12.001 12 6.627 0 11.999-5.374 11.999-12 0-6.628-5.372-12-11.999-12zm4.767 15.025c-.328.784-.812 1.458-1.453 2.02-.641.562-1.41.97-2.308 1.226-.897.255-1.859.336-2.887.243-1.027-.094-1.957-.384-2.79-.871a5.95 5.95 0 01-1.977-1.879c-.52-.803-.846-1.75-.98-2.84-.132-1.09-.047-2.185.257-3.284.305-1.1.848-2.074 1.63-2.924.783-.85 1.76-1.508 2.934-1.974C10.36 4.295 11.666 4.062 13.09 4.062c1.472 0 2.809.28 4.01.84 1.201.56 2.18 1.378 2.937 2.454.757 1.076 1.135 2.373 1.135 3.892 0 1.29-.272 2.47-.816 3.54a7.1 7.1 0 01-2.28 2.657c-1.01.696-2.186 1.144-3.528 1.344v-2.02c.905-.152 1.7-.478 2.385-.978.685-.5 1.187-1.144 1.505-1.932.319-.788.478-1.66.478-2.614 0-1.157-.282-2.14-.846-2.95-.564-.81-1.31-1.43-2.238-1.86a7.485 7.485 0 00-3.184-.645c-1.14 0-2.18.2-3.12.6-.94.4-1.72.96-2.34 1.68-.62.72-1.05 1.56-1.29 2.52-.24.96-.28 1.98-.12 3.06.16 1.08.56 2.02 1.2 2.82.64.8 1.48 1.39 2.52 1.77 1.04.38 2.2.49 3.48.33 1.013-.127 1.897-.478 2.652-1.053.755-.575 1.292-1.33 1.611-2.266z" />
        </svg>
      );
    case 'whatsapp':
      return (
        <svg viewBox="0 0 24 24" fill="#25D366" className={className} style={style}>
          <path d="M12.031 0C5.385 0 0 5.385 0 12.031c0 2.122.554 4.19 1.608 6.012L.055 24l6.113-1.603c1.761.96 3.751 1.467 5.863 1.467 6.646 0 12.031-5.385 12.031-12.033C24.062 5.385 18.677 0 12.031 0zm7.042 16.994c-.292.818-1.464 1.5-2.034 1.595-.54.09-1.246.128-2.012-.118-.466-.149-1.066-.346-1.84-.68-3.238-1.402-5.334-4.66-5.496-4.877-.162-.217-1.31-1.745-1.31-3.328 0-1.583.83-2.361 1.123-2.686.292-.325.64-.407.854-.407.214 0 .428.002.614.011.199.01.463-.075.723.548.267.639.914 2.228.995 2.39.08.163.134.354.027.571-.107.217-.16.353-.32.541-.16.188-.337.42-.48.563-.16.16-.328.334-.141.654.187.32.83 1.368 1.782 2.215 1.226 1.092 2.259 1.43 2.58 1.59.32.16.507.134.693-.08.187-.214.799-.933 1.013-1.253.214-.32.427-.267.72-.16.293.107 1.866.88 2.186 1.04.32.16.533.24.613.373.08.134.08.773-.213 1.591z" />
        </svg>
      );
    case 'linkedin':
      return (
        <svg viewBox="0 0 24 24" fill="#0A66C2" className={className} style={style}>
          <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
        </svg>
      );
    case 'messenger':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} style={style}>
          <circle cx="12" cy="12" r="12" fill="url(#messenger-grad)" />
          <path d="M6 11.8c0-3.3 2.7-6 6-6s6 2.7 6 6c0 1.8-.8 3.5-2.1 4.6-.2.2-.3.4-.3.7l.1 1.7c0 .4-.4.7-.8.5l-1.9-.8c-.3-.1-.6-.1-.9 0-.7.2-1.4.3-2.1.3-3.3 0-6-2.7-6-6z" fill="white" />
          <path d="M9.2 13.5l2.2-2.3c.3-.3.8-.3 1.1 0l1.7 1.3c.5.4 1.2.3 1.6-.2l1.8-2.4c.3-.4-.2-.9-.6-.6l-2.2 2.3c-.3.3-.8.3-1.1 0l-1.7-1.3c-.5-.4-1.2-.3-1.6.2l-1.8 2.4c-.3.4.2.9.6.6z" fill="#0084FF" />
          <defs>
            <linearGradient id="messenger-grad" x1="2.4" y1="21.6" x2="21.6" y2="2.4" gradientUnits="userSpaceOnUse">
              <stop stopColor="#00C6FF" />
              <stop offset=".5" stopColor="#0078FF" />
              <stop offset="1" stopColor="#A033FF" />
            </linearGradient>
          </defs>
        </svg>
      );
    case 'starburst':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} style={style}>
          <path d="M12 0l2.6 6.9L21.4 4l-3.3 6.6L24 12l-5.9 1.4 3.3 6.6-6.8-2.9L12 24l-2.6-6.9L2.6 20l3.3-6.6L0 12l5.9-1.4L2.6 4l6.8 2.9L12 0z" />
        </svg>
      );
    default:
      return (
        <div className={`flex items-center justify-center bg-stone-200 text-stone-700 font-semibold rounded-full text-xs ${className}`} style={style}>
          {name.substring(0, 2).toUpperCase()}
        </div>
      );
  }
};
