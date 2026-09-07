import React, { useState, useEffect } from 'react';
import { Share2, QrCode, Settings } from 'lucide-react';
import { BrandIcon } from './BrandIcons';
import { LinkCard } from './LinkCard';
import { ShareModal } from './ShareModal';
import { QrCodeModal } from './QrCodeModal';
import { LanguageSwitch } from './LanguageSwitch';
import { trackEvent } from '../lib/posthog';
import type { Profile, LinkItem } from '../db/types';

interface ProfileViewProps {
  initialProfile: Profile;
  initialLinks: LinkItem[];
  defaultLang?: 'en' | 'vi';
}

export const ProfileView: React.FC<ProfileViewProps> = ({
  initialProfile,
  initialLinks,
  defaultLang = 'en',
}) => {
  const [lang, setLang] = useState<'en' | 'vi'>(defaultLang);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [isQrOpen, setIsQrOpen] = useState(false);

  // Sync lang from URL search param on mount if present
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlLang = params.get('lang');
      if (urlLang === 'vi' || urlLang === 'en') {
        setLang(urlLang);
      }
    }
  }, []);

  const handleLangChange = (newLang: 'en' | 'vi') => {
    setLang(newLang);
    trackEvent('language_changed', { language: newLang });
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('lang', newLang);
      window.history.replaceState({}, '', url.toString());
    }
  };

  const blogs = initialLinks.filter(l => l.section === 'blogs' && l.is_active);
  const companies = initialLinks.filter(l => l.section === 'companies' && l.is_active);
  const products = initialLinks.filter(l => l.section === 'products' && l.is_active);

  const introText = lang === 'vi' ? initialProfile.intro_vi : initialProfile.intro_en;

  const socialLinks = [
    { name: 'ig', url: 'https://www.instagram.com/imzuey', label: 'Instagram' },
    { name: 'tiktok', url: 'https://www.tiktok.com/@mrgoonvn', label: 'TikTok' },
    { name: 'whatsapp', url: 'https://wa.me/imzuey', label: 'WhatsApp (@imzuey)' },
    { name: 'youtube', url: 'https://youtube.com/@imzuey', label: 'YouTube' },
    { name: 'fb', url: 'https://fb.com/mrgoonie', label: 'Facebook' },
    { name: 'threads', url: 'https://www.threads.com/@imzuey', label: 'Threads' },
    { name: 'x', url: 'https://x.com/goon_nguyen', label: 'X (Twitter)' },
  ];

  return (
    <main className="min-h-screen w-full bg-[#F5EFEB] text-stone-900 font-sans antialiased flex flex-col items-center px-4 py-6 sm:py-10 selection:bg-amber-200">
      {/* Centered Mobile/Tablet Column Container */}
      <div className="w-full max-w-[620px] flex flex-col items-center relative">

        {/* Top Header Bar with Starburst Icon and Controls */}
        <header className="w-full flex items-center justify-between px-2 mb-6">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsShareOpen(true)}
              className="w-10 h-10 rounded-full bg-white/80 hover:bg-white border border-stone-300/80 shadow-xs flex items-center justify-center text-stone-800 transition-all hover:scale-105 active:scale-95"
              aria-label="Brand logo"
            >
              <BrandIcon name="starburst" className="w-5 h-5" />
            </button>
            <a
              href="/studio"
              className="px-2.5 py-1 text-[11px] font-semibold text-stone-500 hover:text-stone-900 bg-stone-200/50 hover:bg-stone-200/80 rounded-full border border-stone-300/50 transition-colors flex items-center gap-1"
              title="Page Builder Studio"
            >
              <Settings className="w-3 h-3" />
              <span>Studio</span>
            </a>
          </div>

          <div className="flex items-center gap-2">
            <LanguageSwitch currentLang={lang} onChange={handleLangChange} />

            <button
              onClick={() => setIsQrOpen(true)}
              className="w-10 h-10 rounded-full bg-white/80 hover:bg-white border border-stone-300/80 shadow-xs flex items-center justify-center text-stone-700 hover:text-stone-900 transition-all hover:scale-105 active:scale-95"
              aria-label="QR Code"
              title={lang === 'vi' ? 'Hiển thị mã QR' : 'Show QR Code'}
            >
              <QrCode className="w-4 h-4" />
            </button>

            <button
              onClick={() => setIsShareOpen(true)}
              className="w-10 h-10 rounded-full bg-white/80 hover:bg-white border border-stone-300/80 shadow-xs flex items-center justify-center text-stone-700 hover:text-stone-900 transition-all hover:scale-105 active:scale-95"
              aria-label="Share profile"
              title={lang === 'vi' ? 'Chia sẻ profile' : 'Share Profile'}
            >
              <Share2 className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Profile Avatar & Bio (Matching sample 01) */}
        <section className="flex flex-col items-center text-center px-4 w-full">
          <div className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-full p-1 bg-white border border-stone-300 shadow-sm mb-4">
            <img
              src={initialProfile.avatar_url}
              alt={initialProfile.name}
              className="w-full h-full rounded-full object-cover shadow-inner"
              loading="eager"
            />
            <div className="absolute bottom-1 right-1 w-5 h-5 bg-amber-400 border-2 border-white rounded-full flex items-center justify-center text-[10px] text-amber-950 font-bold shadow-xs">
              ✓
            </div>
          </div>

          {/* Name & Handle */}
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 font-serif">
            {initialProfile.name}
          </h1>

          {/* Bio text */}
          <p className="mt-2.5 text-xs sm:text-[13px] leading-relaxed text-stone-800 max-w-md font-sans font-medium">
            {introText}
          </p>

          {/* Social Icons Row */}
          <nav className="flex items-center justify-center gap-3 sm:gap-4 mt-5 flex-wrap" aria-label="Social links">
            {socialLinks.map((item) => (
              <a
                key={item.name}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="w-9 h-9 rounded-full flex items-center justify-center text-stone-700 hover:text-black hover:scale-110 active:scale-95 transition-all duration-150"
                aria-label={item.label}
                title={item.label}
                onClick={() => trackEvent('social_clicked', { platform: item.name })}
              >
                <BrandIcon name={item.name} className="w-5 h-5" />
              </a>
            ))}
          </nav>
        </section>

        {/* Sections & Link Cards */}
        <div className="w-full mt-8 space-y-8">
          {/* 1. Blogs Section */}
          {blogs.length > 0 && (
            <section className="w-full">
              <h2 className="text-xl sm:text-2xl font-black text-center text-stone-900 font-serif mb-4 tracking-tight">
                {lang === 'vi' ? 'Bài viết & Bản tin' : 'Blogs'}
              </h2>
              <div className="space-y-2">
                {blogs.map((item) => (
                  <LinkCard key={item.id} item={item} lang={lang} onShareLink={() => setIsShareOpen(true)} />
                ))}
              </div>
            </section>
          )}

          {/* 2. Companies Section ("Found by me!") */}
          {companies.length > 0 && (
            <section className="w-full">
              <h2 className="text-xl sm:text-2xl font-black text-center text-stone-900 font-serif mb-4 tracking-tight">
                {lang === 'vi' ? 'Sáng lập & Điều hành' : 'Found by me!'}
              </h2>
              <div className="space-y-2">
                {companies.map((item) => (
                  <LinkCard key={item.id} item={item} lang={lang} onShareLink={() => setIsShareOpen(true)} />
                ))}
              </div>
            </section>
          )}

          {/* 3. Products Section */}
          {products.length > 0 && (
            <section className="w-full">
              <h2 className="text-xl sm:text-2xl font-black text-center text-stone-900 font-serif mb-4 tracking-tight">
                {lang === 'vi' ? 'Sản phẩm & Công cụ' : 'Products & Tools'}
              </h2>
              <div className="space-y-2">
                {products.map((item) => (
                  <LinkCard key={item.id} item={item} lang={lang} onShareLink={() => setIsShareOpen(true)} />
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Bottom Floating Pill & Footer */}
        <footer className="w-full mt-12 pb-10 flex flex-col items-center text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-white/90 backdrop-blur-md rounded-full border border-stone-300/80 shadow-card text-xs text-stone-700">
            <span className="font-serif font-bold text-stone-900">zuey.me</span>
            <span className="text-stone-300">•</span>
            <span className="text-stone-500 font-mono text-[11px]">{initialProfile.email}</span>
            <span className="text-stone-300">•</span>
            <a href="/docs" className="hover:text-black font-medium underline underline-offset-2">API Docs</a>
            <span className="text-stone-300">•</span>
            <a href="/llms.txt" className="hover:text-black font-medium underline underline-offset-2">llms.txt</a>
          </div>

          <p className="mt-4 text-[11px] text-stone-500 max-w-xs leading-relaxed">
            Crafted with ❤️ by Duy Nguyen. Hosted on Cloudflare Edge.
          </p>
        </footer>
      </div>

      {/* Share Modal Recreation */}
      <ShareModal
        isOpen={isShareOpen}
        onClose={() => setIsShareOpen(false)}
        profile={initialProfile}
        lang={lang}
        onOpenQr={() => {
          setIsShareOpen(false);
          setIsQrOpen(true);
        }}
      />

      {/* QR Code Modal */}
      <QrCodeModal
        isOpen={isQrOpen}
        onClose={() => setIsQrOpen(false)}
        lang={lang}
      />
    </main>
  );
};
