export interface Profile {
  id: string;
  name: string;
  handle: string;
  email: string;
  avatar_url: string;
  intro_en: string;
  intro_vi: string;
  theme: string;
  custom_css?: string;
  updated_at?: string;
}

export interface LinkItem {
  id: string;
  section: 'blogs' | 'companies' | 'products' | 'socials';
  title_en: string;
  title_vi: string;
  subtitle_en?: string;
  subtitle_vi?: string;
  url: string;
  icon?: string;
  order_index: number;
  is_active: boolean;
  click_count?: number;
  updated_at?: string;
}

export interface ApiKey {
  id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  role: 'admin' | 'read';
  created_at: string;
  last_used_at?: string;
}

export interface SocialLink {
  id: string;
  platform: 'x' | 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'threads' | 'whatsapp' | 'linkedin' | 'email';
  url: string;
  label: string;
}
