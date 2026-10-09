import React from 'react';
import {
  BookOpen, Briefcase, CreditCard, GitBranch, GraduationCap, LayoutGrid, Newspaper, Palette, Plug, Sparkles, SquarePlay, User,
} from 'lucide-react';
import type { AppId } from './apps';

type IconType = React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

const ICONS: Record<Exclude<AppId, 'about'>, IconType> = {
  ai: Sparkles,
  knowledges: BookOpen,
  reads: Newspaper,
  zueytube: SquarePlay,
  github: GitBranch,
  pricing: CreditCard,
  business: Briefcase,
  mcp: Plug,
  account: User,
  appearance: Palette,
  '200lab': GraduationCap,
};

interface AppGlyphProps {
  id: AppId | 'expose';
  avatar?: string;
  className?: string;
}

/** App tile used by the dock, the phone home screen and Exposé labels (decorative: callers label it). */
export const AppGlyph: React.FC<AppGlyphProps> = ({ id, avatar, className = '' }) => {
  if (id === 'about') {
    return (
      <span className={`os-g os-g--about ${className}`} aria-hidden="true">
        {avatar ? <img src={avatar} alt="" width={52} height={52} loading="lazy" decoding="async" /> : 'Z'}
      </span>
    );
  }
  const Icon = id === 'expose' ? LayoutGrid : ICONS[id];
  return (
    <span className={`os-g os-g--${id} ${className}`} aria-hidden="true">
      <Icon aria-hidden />
    </span>
  );
};
