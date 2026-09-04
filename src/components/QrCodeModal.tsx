import React, { useEffect, useState } from 'react';
import { X, Download, Copy, Check } from 'lucide-react';

interface QrCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  url?: string;
  lang: 'en' | 'vi';
}

export const QrCodeModal: React.FC<QrCodeModalProps> = ({
  isOpen,
  onClose,
  url,
  lang,
}) => {
  const [qrSrc, setQrSrc] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const targetUrl = url || (typeof window !== 'undefined' ? window.location.origin : 'https://zuey.me');

  useEffect(() => {
    if (!isOpen) return;

    import('qrcode')
      .then((mod) => {
        const qrcode = mod.default || mod;
        return qrcode.toDataURL(targetUrl, {
          width: 320,
          margin: 2,
          color: {
            dark: '#1c1917',
            light: '#ffffff',
          },
          errorCorrectionLevel: 'H',
        });
      })
      .then((dataUrl) => setQrSrc(dataUrl))
      .catch((err) => console.error('QR Code error:', err));
  }, [isOpen, targetUrl]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(targetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleDownload = () => {
    if (!qrSrc) return;
    const a = document.createElement('a');
    a.href = qrSrc;
    a.download = 'zuey-me-qrcode.png';
    a.click();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fadeIn">
      <div 
        className="relative w-full max-w-sm bg-white rounded-3xl shadow-2xl p-6 sm:p-7 border border-stone-200 text-center animate-scaleUp"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-stone-100">
          <h2 className="text-base font-bold text-stone-900 font-sans tracking-tight">
            {lang === 'vi' ? 'Quét mã QR Profile' : 'Scan Profile QR'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-full transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-5 flex flex-col items-center">
          <div className="p-3 bg-white border-2 border-stone-200 rounded-2xl shadow-inner relative group">
            {qrSrc ? (
              <img
                src={qrSrc}
                alt="Zuey.me QR Code"
                className="w-56 h-56 rounded-lg"
              />
            ) : (
              <div className="w-56 h-56 flex items-center justify-center bg-stone-100 rounded-lg text-stone-400 text-xs">
                Generating QR...
              </div>
            )}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-10 h-10 bg-white rounded-full p-1 shadow-md border border-stone-200">
                <img
                  src="https://cdn.zuey.me/avatar.png"
                  alt="avatar"
                  className="w-full h-full rounded-full object-cover"
                />
              </div>
            </div>
          </div>

          <p className="mt-4 text-xs text-stone-500 font-mono tracking-tight bg-stone-50 px-3 py-1 rounded-full border border-stone-200">
            {targetUrl}
          </p>

          <p className="mt-2 text-xs text-stone-600 max-w-xs">
            {lang === 'vi'
              ? 'Sử dụng camera điện thoại để quét mã và truy cập profile ngay lập tức.'
              : 'Scan with your mobile camera to instantly access the live profile.'}
          </p>
        </div>

        <div className="mt-6 flex gap-2">
          <button
            onClick={handleDownload}
            className="flex-1 py-2.5 px-3 bg-stone-900 hover:bg-black text-white rounded-full font-medium text-xs flex items-center justify-center gap-1.5 transition-all shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            {lang === 'vi' ? 'Tải ảnh PNG' : 'Download PNG'}
          </button>
          <button
            onClick={handleCopy}
            className="flex-1 py-2.5 px-3 bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-full font-medium text-xs flex items-center justify-center gap-1.5 transition-colors border border-stone-200"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? (lang === 'vi' ? 'Đã sao chép' : 'Copied!') : (lang === 'vi' ? 'Sao chép link' : 'Copy Link')}
          </button>
        </div>
      </div>
    </div>
  );
};
