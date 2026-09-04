import React, { useState } from 'react';
import { X, Link2, QrCode, Check } from 'lucide-react';
import { BrandIcon } from './BrandIcons';
import type { Profile } from '../db/types';

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: Profile;
  lang: 'en' | 'vi';
  onOpenQr: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({
  isOpen,
  onClose,
  profile,
  lang,
  onOpenQr,
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const currentUrl = typeof window !== 'undefined' ? window.location.origin : 'https://zuey.me';
  const shareText = lang === 'vi'
    ? `Xem profile của Duy Nguyen (zuey): ${currentUrl}`
    : `Check out Duy Nguyen's profile: ${currentUrl}`;

  const copyToClipboard = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(currentUrl);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  };

  const shareItems = [
    {
      id: 'copy',
      label: lang === 'vi' ? 'Sao chép link' : 'Copy Link',
      icon: copied ? <Check className="w-6 h-6 text-emerald-600" /> : <Link2 className="w-6 h-6 text-stone-700" />,
      bg: 'bg-stone-100 hover:bg-stone-200 border border-stone-200',
      action: copyToClipboard,
    },
    {
      id: 'x',
      label: 'X',
      icon: <BrandIcon name="x" className="w-5 h-5 text-white" />,
      bg: 'bg-black hover:bg-neutral-800 text-white',
      action: () => window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}`, '_blank'),
    },
    {
      id: 'facebook',
      label: 'Facebook',
      icon: <BrandIcon name="fb" className="w-6 h-6" />,
      bg: 'bg-[#1877F2]/10 hover:bg-[#1877F2]/20 border border-[#1877F2]/30',
      action: () => window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(currentUrl)}`, '_blank'),
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      icon: <BrandIcon name="whatsapp" className="w-6 h-6" />,
      bg: 'bg-[#25D366]/10 hover:bg-[#25D366]/20 border border-[#25D366]/30',
      action: () => window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`, '_blank'),
    },
    {
      id: 'linkedin',
      label: 'LinkedIn',
      icon: <BrandIcon name="linkedin" className="w-6 h-6" />,
      bg: 'bg-[#0A66C2]/10 hover:bg-[#0A66C2]/20 border border-[#0A66C2]/30',
      action: () => window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(currentUrl)}`, '_blank'),
    },
    {
      id: 'messenger',
      label: 'Messenger',
      icon: <BrandIcon name="messenger" className="w-6 h-6" />,
      bg: 'bg-sky-50 hover:bg-sky-100 border border-sky-200',
      action: () => window.open(`fb-messenger://share/?link=${encodeURIComponent(currentUrl)}`, '_blank'),
    },
    {
      id: 'qrcode',
      label: 'QR Code',
      icon: <QrCode className="w-6 h-6 text-stone-800" />,
      bg: 'bg-amber-100 hover:bg-amber-200 border border-amber-300 text-amber-900',
      action: onOpenQr,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fadeIn">
      <div 
        className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl p-6 sm:p-7 border border-stone-200 overflow-hidden transform transition-all animate-scaleUp"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-stone-100">
          <h2 className="text-lg font-bold text-stone-900 font-sans tracking-tight">
            {lang === 'vi' ? 'Chia sẻ Profile' : 'Share Profile'}
          </h2>
          <button
            onClick={onClose}
            className="p-2 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-full transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Preview Card matching sample 02 */}
        <div className="mt-5 p-6 rounded-2xl bg-[#2E1C2B] text-white text-center shadow-lg relative overflow-hidden">
          <div className="relative z-10 flex flex-col items-center">
            <div className="relative w-20 h-20 mb-3 rounded-full overflow-hidden border-2 border-white/40 shadow-inner">
              <img
                src={profile.avatar_url}
                alt={profile.name}
                className="w-full h-full object-cover"
                loading="eager"
              />
            </div>
            <h3 className="text-xl font-bold tracking-tight font-sans text-white">
              {profile.name}
            </h3>
            <p className="text-xs font-medium text-purple-200/80 mt-1 flex items-center gap-1">
              <span className="text-amber-400">✱</span> zuey.me {profile.handle}
            </p>
          </div>
          {/* Subtle background aesthetic highlight */}
          <div className="absolute -top-12 -right-12 w-32 h-32 bg-purple-600/20 rounded-full blur-2xl pointer-events-none" />
          <div className="absolute -bottom-12 -left-12 w-32 h-32 bg-amber-600/15 rounded-full blur-2xl pointer-events-none" />
        </div>

        {/* Share Icons Grid */}
        <div className="mt-6">
          <div className="grid grid-cols-4 gap-y-4 gap-x-2 text-center">
            {shareItems.map((item) => (
              <button
                key={item.id}
                onClick={item.action}
                className="flex flex-col items-center group transition-transform active:scale-95"
              >
                <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-all duration-200 group-hover:scale-105 shadow-sm ${item.bg}`}>
                  {item.icon}
                </div>
                <span className="mt-2 text-xs font-medium text-stone-700 truncate max-w-[72px]">
                  {item.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Copy Toast Feedback */}
        {copied && (
          <div className="mt-4 p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-center text-xs font-semibold flex items-center justify-center gap-1.5 animate-bounce">
            <Check className="w-4 h-4 text-emerald-600" />
            {lang === 'vi' ? 'Đã sao chép liên kết vào bộ nhớ tạm!' : 'Profile link copied to clipboard!'}
          </div>
        )}

        {/* Bottom CTA */}
        <div className="mt-6 pt-4 border-t border-stone-100 flex flex-col gap-2">
          <button
            onClick={copyToClipboard}
            className="w-full py-3.5 bg-stone-900 hover:bg-black text-white rounded-full font-semibold text-sm transition-all shadow-md active:scale-98"
          >
            {copied ? (lang === 'vi' ? '✓ Đã sao chép' : '✓ Copied!') : (lang === 'vi' ? 'Sao chép liên kết URL' : 'Copy Profile URL')}
          </button>
          <button
            onClick={onOpenQr}
            className="w-full py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-full font-medium text-xs transition-colors flex items-center justify-center gap-2"
          >
            <QrCode className="w-4 h-4 text-stone-600" />
            {lang === 'vi' ? 'Hiển thị mã QR' : 'Show QR Code'}
          </button>
        </div>
      </div>
    </div>
  );
};
