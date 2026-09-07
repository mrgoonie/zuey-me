import React, { useState } from 'react';
import { MoreVertical, ExternalLink, Copy, Share2, Check } from 'lucide-react';
import { BrandIcon } from './BrandIcons';
import type { LinkItem } from '../db/types';
import { trackEvent } from '../lib/posthog';

interface LinkCardProps {
  item: LinkItem;
  lang: 'en' | 'vi';
  onShareLink?: (item: LinkItem) => void;
}

export const LinkCard: React.FC<LinkCardProps> = ({
  item,
  lang,
  onShareLink,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const title = lang === 'vi' ? item.title_vi || item.title_en : item.title_en;
  const subtitle = lang === 'vi' ? item.subtitle_vi || item.subtitle_en : item.subtitle_en;

  const handleCardClick = () => {
    trackEvent('link_clicked', {
      id: item.id,
      section: item.section,
      title: item.title_en,
      url: item.url,
    });
  };

  const handleCopyLink = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.url);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setShowMenu(false);
      }, 1500);
    } catch {
      // ignore
    }
  };

  const handleShare = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowMenu(false);
    if (onShareLink) {
      onShareLink(item);
    } else if (typeof navigator !== 'undefined' && navigator.share) {
      navigator.share({
        title,
        text: subtitle || title,
        url: item.url,
      }).catch(() => {});
    }
  };

  return (
    <div className={`relative group w-full my-3 ${showMenu ? 'z-40' : 'z-0'}`}>
      {/* Click-outside backdrop */}
      {showMenu && (
        <div
          className="fixed inset-0 z-40 bg-transparent"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowMenu(false);
          }}
        />
      )}
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleCardClick}
        className="flex items-center w-full min-h-[64px] py-2.5 px-3.5 sm:px-4 bg-white/95 hover:bg-white text-stone-900 rounded-full border border-stone-300/80 shadow-card hover:shadow-card-hover transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0"
      >
        {/* Left Icon (42x42px circle) */}
        <div className="flex-shrink-0 w-11 h-11 rounded-full overflow-hidden flex items-center justify-center bg-stone-100 border border-stone-200 shadow-xs">
          {item.icon ? (
            <BrandIcon name={item.icon} className="w-7 h-7" />
          ) : (
            <span className="font-bold text-xs text-stone-600">
              {title.substring(0, 2).toUpperCase()}
            </span>
          )}
        </div>

        {/* Center Content */}
        <div className="flex-1 min-w-0 mx-3.5 text-center sm:text-left">
          <h4 className="font-semibold text-sm sm:text-[15px] leading-snug tracking-tight text-stone-900 group-hover:text-black line-clamp-2">
            {title}
          </h4>
          {subtitle && (
            <p className="text-xs text-stone-500 font-normal leading-tight truncate mt-0.5 hidden sm:block">
              {subtitle}
            </p>
          )}
        </div>

        {/* Right 3-dots Menu Button */}
        <div className="flex-shrink-0 relative">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
            className="w-9 h-9 rounded-full flex items-center justify-center text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
            aria-label="More options"
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          {/* Dropdown Menu */}
          {showMenu && (
            <div
              className="absolute right-0 top-10 w-44 bg-white rounded-2xl shadow-xl border border-stone-200 py-1.5 z-50 animate-scaleUp text-left"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={handleCopyLink}
                className="w-full px-3.5 py-2 text-xs font-medium text-stone-700 hover:bg-stone-50 flex items-center gap-2 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-stone-400" />}
                {copied ? (lang === 'vi' ? 'Đã sao chép' : 'Copied') : (lang === 'vi' ? 'Sao chép link' : 'Copy link')}
              </button>

              <button
                onClick={handleShare}
                className="w-full px-3.5 py-2 text-xs font-medium text-stone-700 hover:bg-stone-50 flex items-center gap-2 transition-colors"
              >
                <Share2 className="w-3.5 h-3.5 text-stone-400" />
                {lang === 'vi' ? 'Chia sẻ liên kết' : 'Share link'}
              </button>

              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full px-3.5 py-2 text-xs font-medium text-stone-700 hover:bg-stone-50 flex items-center gap-2 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5 text-stone-400" />
                {lang === 'vi' ? 'Mở tab mới' : 'Open in new tab'}
              </a>
            </div>
          )}
        </div>
      </a>
    </div>
  );
};
