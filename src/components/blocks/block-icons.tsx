import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, AtSign, Atom, Award, BadgeCheck, Ban, Bell, Book, BookOpen,
  Bookmark, Bot, Braces, Brain, Briefcase, Bug, Building2, Calculator, Calendar, Camera, ChartColumn, ChartLine,
  ChartPie, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleHelp, CircleX, ClipboardList, Clock,
  Cloud, Code, Compass, Cpu, CreditCard, Database, DollarSign, ExternalLink, Eye, File as FileIcon, FileText, Flag, FlaskConical,
  Flame, Folder, Funnel, Gift, GitBranch, Globe, GraduationCap, Handshake, Hash, Headphones, Heart, Hourglass, House,
  Image as ImageIcon, Info, Key, Keyboard, Languages, Laptop, Layers, Library, Lightbulb, Link as LinkIcon, ListChecks,
  Lock, LockOpen, Mail, Map as MapIcon, MapPin, Megaphone, MessageCircle, MessageSquare, Mic, Microscope, Monitor, Moon, Music, NotebookPen, Package,
  Paperclip, Pencil, Phone, Presentation, Puzzle, Quote, RefreshCw, Repeat, Rocket, Rss, School, Search, Send, Server,
  Settings, Share2, ShieldCheck, ShoppingCart, Smartphone, Smile, Sparkles, Star, Sun, Tag, Target, Terminal,
  ThumbsDown, ThumbsUp, TrendingDown, TrendingUp, TriangleAlert, Trophy, User, Users, Video, Wallet, Wifi, Wrench, X, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ICON_PIXELS, isIconName } from '../../lib/blocks/icons';
import type { IconName, IconSize } from '../../lib/blocks/icons';

/**
 * Allowlisted name → individually imported Lucide component. Typed as a total record, so adding a
 * name to the registry without a component (or the reverse) fails the type check.
 */
export const ICON_COMPONENTS: Readonly<Record<IconName, LucideIcon>> = {
  'arrow-right': ArrowRight, 'arrow-left': ArrowLeft, 'arrow-up': ArrowUp, 'arrow-down': ArrowDown,
  'arrow-up-right': ArrowUpRight, 'chevron-right': ChevronRight, 'chevron-down': ChevronDown, 'refresh-cw': RefreshCw,
  'repeat': Repeat, 'external-link': ExternalLink,
  'check': Check, 'x': X, 'circle-check': CircleCheck, 'circle-x': CircleX, 'circle-alert': CircleAlert,
  'triangle-alert': TriangleAlert, 'info': Info, 'circle-help': CircleHelp, 'ban': Ban, 'shield-check': ShieldCheck,
  'badge-check': BadgeCheck, 'clock': Clock, 'hourglass': Hourglass, 'bell': Bell, 'flag': Flag, 'thumbs-up': ThumbsUp,
  'thumbs-down': ThumbsDown, 'star': Star, 'heart': Heart, 'sparkles': Sparkles, 'zap': Zap, 'flame': Flame,
  'award': Award, 'trophy': Trophy, 'target': Target,
  'book': Book, 'book-open': BookOpen, 'bookmark': Bookmark, 'file': FileIcon, 'file-text': FileText, 'folder': Folder,
  'image': ImageIcon, 'camera': Camera, 'video': Video, 'music': Music, 'mic': Mic, 'headphones': Headphones,
  'calendar': Calendar, 'map': MapIcon, 'map-pin': MapPin, 'globe': Globe, 'house': House, 'key': Key, 'lock': Lock,
  'lock-open': LockOpen, 'gift': Gift, 'package': Package, 'shopping-cart': ShoppingCart, 'tag': Tag,
  'paperclip': Paperclip, 'pencil': Pencil, 'wrench': Wrench, 'settings': Settings, 'search': Search, 'funnel': Funnel,
  'eye': Eye, 'link': LinkIcon, 'mail': Mail, 'phone': Phone, 'send': Send, 'sun': Sun, 'moon': Moon, 'cloud': Cloud,
  'compass': Compass, 'rocket': Rocket, 'lightbulb': Lightbulb, 'puzzle': Puzzle, 'layers': Layers,
  'code': Code, 'terminal': Terminal, 'cpu': Cpu, 'database': Database, 'server': Server, 'wifi': Wifi,
  'smartphone': Smartphone, 'laptop': Laptop, 'monitor': Monitor, 'bot': Bot, 'brain': Brain, 'git-branch': GitBranch,
  'bug': Bug, 'braces': Braces, 'keyboard': Keyboard,
  'graduation-cap': GraduationCap, 'school': School, 'notebook-pen': NotebookPen, 'library': Library,
  'presentation': Presentation, 'calculator': Calculator, 'flask-conical': FlaskConical, 'atom': Atom,
  'microscope': Microscope, 'languages': Languages, 'quote': Quote, 'list-checks': ListChecks,
  'clipboard-list': ClipboardList,
  'briefcase': Briefcase, 'building-2': Building2, 'chart-column': ChartColumn, 'chart-line': ChartLine,
  'chart-pie': ChartPie, 'trending-up': TrendingUp, 'trending-down': TrendingDown, 'dollar-sign': DollarSign,
  'wallet': Wallet, 'credit-card': CreditCard, 'handshake': Handshake, 'users': Users, 'user': User,
  'megaphone': Megaphone,
  'share-2': Share2, 'message-circle': MessageCircle, 'message-square': MessageSquare, 'at-sign': AtSign, 'hash': Hash,
  'rss': Rss, 'smile': Smile,
};

export interface IconGlyphProps {
  /** Untrusted input is fine: anything outside the allowlist renders nothing. */
  name: unknown;
  size: IconSize | number;
  /** Accessible name; when absent the icon is decorative (aria-hidden). */
  label?: string;
  className?: string;
}

/** Renders one allowlisted icon as inline SVG, or nothing for an unknown name. */
export function IconGlyph({ name, size, label, className }: IconGlyphProps) {
  if (!isIconName(name)) return null;
  const Icon = ICON_COMPONENTS[name];
  const px = typeof size === 'number' ? size : ICON_PIXELS[size];
  const a11y = label
    ? { role: 'img', 'aria-label': label }
    : { 'aria-hidden': true };
  return <Icon size={px} className={className} focusable="false" data-icon={name} {...a11y} />;
}
