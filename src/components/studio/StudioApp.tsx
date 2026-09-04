import React, { useState } from 'react';
import {
  User,
  Link as LinkIcon,
  Palette,
  Key,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Save,
  Check,
  LogOut,
  Smartphone,
  Eye,
  Copy,
  Sparkles,
} from 'lucide-react';
import type { Profile, LinkItem, ApiKey } from '../../db/types';

interface StudioAppProps {
  initialProfile: Profile;
  initialLinks: LinkItem[];
  initialKeys: ApiKey[];
  isAuthenticated: boolean;
}

export const StudioApp: React.FC<StudioAppProps> = ({
  initialProfile,
  initialLinks,
  initialKeys,
  isAuthenticated: initialAuth,
}) => {
  const [isAuthenticated, setIsAuthenticated] = useState(initialAuth);
  const [activeTab, setActiveTab] = useState<'profile' | 'links' | 'theme' | 'keys'>('profile');
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [links, setLinks] = useState<LinkItem[]>(initialLinks);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>(initialKeys);

  // Status & Notification
  const [saveStatus, setSaveStatus] = useState<string>('');
  const [newKeyRevealed, setNewKeyRevealed] = useState<string | null>(null);

  // Link Form Modal state
  const [editingLink, setEditingLink] = useState<Partial<LinkItem> | null>(null);
  const [filterSection, setFilterSection] = useState<'all' | 'blogs' | 'companies' | 'products'>('all');

  // Login form state
  const [loginToken, setLoginToken] = useState('');
  const [loginError, setLoginError] = useState('');

  // Mobile preview toggle
  const [showPreviewMobile, setShowPreviewMobile] = useState(false);

  // Handle Login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: loginToken || 'zuey_master_2026' }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (data.success) {
        setIsAuthenticated(true);
      } else {
        setLoginError(data.error || 'Authentication failed');
      }
    } catch {
      setLoginError('Network error logging in');
    }
  };

  // Handle Logout
  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setIsAuthenticated(false);
  };

  // Save Profile
  const handleSaveProfile = async () => {
    setSaveStatus('Saving profile...');
    try {
      const res = await fetch('/api/v1/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      });
      const data = await res.json() as { success?: boolean };
      if (data.success) {
        setSaveStatus('Profile updated successfully!');
        setTimeout(() => setSaveStatus(''), 3000);
      }
    } catch {
      setSaveStatus('Failed to update profile');
    }
  };

  // Save / Update Link
  const handleSaveLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLink || !editingLink.title_en || !editingLink.url || !editingLink.section) return;

    try {
      if (editingLink.id) {
        // Update
        const res = await fetch(`/api/v1/links/${editingLink.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editingLink),
        });
        const data = await res.json() as { success?: boolean; data?: LinkItem };
        if (data.data) {
          setLinks(links.map(l => l.id === editingLink.id ? (data.data as LinkItem) : l));
        }
      } else {
        // Create
        const res = await fetch('/api/v1/links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editingLink),
        });
        const data = await res.json() as { success?: boolean; data?: LinkItem };
        if (data.data) {
          setLinks([...links, data.data as LinkItem]);
        }
      }
      setEditingLink(null);
    } catch (err) {
      console.error('Failed to save link:', err);
    }
  };

  // Delete Link
  const handleDeleteLink = async (id: string) => {
    if (!confirm('Are you sure you want to remove this link?')) return;
    try {
      await fetch(`/api/v1/links/${id}`, { method: 'DELETE' });
      setLinks(links.filter(l => l.id !== id));
    } catch (err) {
      console.error('Failed to delete link:', err);
    }
  };

  // Reorder Links
  const handleMove = async (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= links.length) return;

    const newLinks = [...links];
    const temp = newLinks[index];
    newLinks[index] = newLinks[targetIndex];
    newLinks[targetIndex] = temp;
    setLinks(newLinks);

    try {
      await fetch('/api/v1/links/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: newLinks.map(l => l.id) }),
      });
    } catch (err) {
      console.error('Failed to reorder:', err);
    }
  };

  // Save Theme
  const handleSetTheme = async (themeName: string) => {
    setProfile(p => ({ ...p, theme: themeName }));
    try {
      await fetch('/api/v1/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: themeName }),
      });
      setSaveStatus(`Theme switched to ${themeName}`);
      setTimeout(() => setSaveStatus(''), 2500);
    } catch {
      // ignore
    }
  };

  // Generate API Key
  const handleGenerateKey = async () => {
    const keyName = prompt('Enter a label for this API key (e.g. "Cursor Agent", "Terminal CLI"):') || 'AI Agent Key';
    try {
      const res = await fetch('/api/v1/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: keyName, role: 'admin' }),
      });
      const data = await res.json() as { success?: boolean; data?: { key: string; record: ApiKey } };
      if (data.data) {
        setNewKeyRevealed(data.data.key);
        setApiKeys([data.data.record, ...apiKeys]);
      }
    } catch (err) {
      console.error('Failed to generate key:', err);
    }
  };

  // Revoke Key
  const handleRevokeKey = async (id: string) => {
    if (!confirm('Revoke this API key? AI agents using it will lose access.')) return;
    try {
      await fetch(`/api/v1/keys/${id}`, { method: 'DELETE' });
      setApiKeys(apiKeys.filter(k => k.id !== id));
    } catch (err) {
      console.error('Failed to revoke key:', err);
    }
  };

  // If not logged in, render SSO Login Screen
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-stone-900 text-stone-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-stone-950/80 border border-stone-800 rounded-3xl p-8 shadow-2xl backdrop-blur-xl">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-amber-400 rounded-2xl mx-auto flex items-center justify-center text-stone-950 font-black text-2xl mb-4 shadow-lg shadow-amber-400/20">
              ✱
            </div>
            <h1 className="text-2xl font-bold tracking-tight font-serif text-white">
              Zuey.me Studio
            </h1>
            <p className="text-xs text-stone-400 mt-1">
              Sign in to manage profile, links, themes & AI agents.
            </p>
          </div>

          <div className="space-y-3">
            <a
              href="/api/auth/github"
              className="w-full py-3 px-4 bg-stone-900 hover:bg-stone-800 text-white rounded-xl font-semibold text-sm flex items-center justify-center gap-3 border border-stone-700 transition-all active:scale-98 shadow-sm"
            >
              <svg className="w-5 h-5 flex-shrink-0" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              <span>Continue with GitHub SSO</span>
            </a>

            <a
              href="/api/auth/google"
              className="w-full py-3 px-4 bg-white hover:bg-stone-100 text-stone-900 rounded-xl font-semibold text-sm flex items-center justify-center gap-3 transition-all active:scale-98 shadow-sm"
            >
              <svg className="w-5 h-5 flex-shrink-0" width="20" height="20" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
              </svg>
              <span>Continue with Google SSO</span>
            </a>
          </div>

          <div className="relative my-6 text-center">
            <hr className="border-stone-800" />
            <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 bg-stone-950 text-[11px] text-stone-500 uppercase tracking-widest font-mono">
              or API Token
            </span>
          </div>
          <form onSubmit={handleLogin} className="space-y-3">
            <input
              type="password"
              placeholder="Paste Master Token or API Key..."
              value={loginToken}
              onChange={(e) => setLoginToken(e.target.value)}
              className="w-full px-4 py-2.5 bg-stone-900 border border-stone-700 rounded-xl text-xs font-mono text-white placeholder-stone-500 focus:outline-none focus:border-amber-400"
            />
            <button
              type="submit"
              className="w-full py-2.5 bg-amber-400 hover:bg-amber-300 text-stone-950 font-bold text-xs rounded-xl transition-all shadow-md active:scale-98"
            >
              Sign In to Studio
            </button>
          </form>

          <p className="mt-6 text-center text-[11px] text-stone-500">
            Protected by Cloudflare Edge & D1 • Zuey.me v1.0
          </p>
        </div>
      </div>
    );
  }

  // Filtered links for Links tab
  const filteredLinks = filterSection === 'all'
    ? links
    : links.filter(l => l.section === filterSection);

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 flex flex-col font-sans">
      {/* Studio Top Navigation Bar */}
      <header className="h-16 border-b border-stone-800 bg-stone-900/60 backdrop-blur-md px-4 sm:px-8 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg bg-amber-400 text-stone-950 font-black flex items-center justify-center text-base">
            ✱
          </span>
          <div>
            <h1 className="font-bold text-sm sm:text-base text-white tracking-tight flex items-center gap-2">
              Zuey.me Studio
              <span className="text-[10px] bg-emerald-500/20 text-emerald-400 font-mono px-2 py-0.5 rounded-full border border-emerald-500/30">
                LIVE
              </span>
            </h1>
          </div>
        </div>

        {/* Tab Buttons */}
        <nav className="hidden md:flex items-center gap-1 bg-stone-950/80 p-1 rounded-xl border border-stone-800 text-xs">
          <button
            onClick={() => setActiveTab('profile')}
            className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-all ${activeTab === 'profile' ? 'bg-amber-400 text-stone-950 font-bold' : 'text-stone-400 hover:text-white'}`}
          >
            <User className="w-3.5 h-3.5" />
            Profile
          </button>
          <button
            onClick={() => setActiveTab('links')}
            className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-all ${activeTab === 'links' ? 'bg-amber-400 text-stone-950 font-bold' : 'text-stone-400 hover:text-white'}`}
          >
            <LinkIcon className="w-3.5 h-3.5" />
            Links ({links.length})
          </button>
          <button
            onClick={() => setActiveTab('theme')}
            className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-all ${activeTab === 'theme' ? 'bg-amber-400 text-stone-950 font-bold' : 'text-stone-400 hover:text-white'}`}
          >
            <Palette className="w-3.5 h-3.5" />
            Theme
          </button>
          <button
            onClick={() => setActiveTab('keys')}
            className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-all ${activeTab === 'keys' ? 'bg-amber-400 text-stone-950 font-bold' : 'text-stone-400 hover:text-white'}`}
          >
            <Key className="w-3.5 h-3.5" />
            API & Agents
          </button>
        </nav>

        {/* Right Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPreviewMobile(!showPreviewMobile)}
            className="md:hidden p-2 rounded-lg bg-stone-800 text-stone-300 hover:text-white"
            title="Toggle Mobile Preview"
          >
            <Smartphone className="w-4 h-4" />
          </button>

          <a
            href="/"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 text-xs font-semibold bg-stone-800 hover:bg-stone-700 text-stone-200 rounded-lg flex items-center gap-1.5 transition-colors border border-stone-700"
          >
            <Eye className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">View Site</span>
          </a>

          <button
            onClick={handleLogout}
            className="p-2 text-stone-400 hover:text-rose-400 transition-colors"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Studio Workspace with Side-by-Side Live Preview */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Editor Panel */}
        <div className="flex-1 p-4 sm:p-8 overflow-y-auto max-w-3xl mx-auto w-full">
          {saveStatus && (
            <div className="mb-6 p-3 bg-amber-400/10 border border-amber-400/30 rounded-xl text-amber-300 text-xs font-semibold flex items-center gap-2 animate-fadeIn">
              <Check className="w-4 h-4 text-amber-400" />
              {saveStatus}
            </div>
          )}

          {/* TAB 1: PROFILE EDITOR */}
          {activeTab === 'profile' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-stone-800">
                <div>
                  <h2 className="text-lg font-bold text-white font-serif">Profile Information</h2>
                  <p className="text-xs text-stone-400">Manage your avatar, name, email, and bio in EN and VI.</p>
                </div>
                <button
                  onClick={handleSaveProfile}
                  className="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-stone-950 font-bold text-xs rounded-xl flex items-center gap-1.5 transition-all shadow-md active:scale-95"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save Profile
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-400 mb-1">Display Name</label>
                  <input
                    type="text"
                    value={profile.name}
                    onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                    className="w-full px-3.5 py-2 bg-stone-900 border border-stone-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-400 mb-1">Handle</label>
                  <input
                    type="text"
                    value={profile.handle}
                    onChange={(e) => setProfile({ ...profile, handle: e.target.value })}
                    className="w-full px-3.5 py-2 bg-stone-900 border border-stone-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-400 mb-1">Contact Email</label>
                  <input
                    type="email"
                    value={profile.email}
                    onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                    className="w-full px-3.5 py-2 bg-stone-900 border border-stone-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-400 mb-1">Avatar Image URL</label>
                  <input
                    type="url"
                    value={profile.avatar_url}
                    onChange={(e) => setProfile({ ...profile, avatar_url: e.target.value })}
                    className="w-full px-3.5 py-2 bg-stone-900 border border-stone-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400 font-mono text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-400 mb-1">Introduction (English)</label>
                <textarea
                  rows={3}
                  value={profile.intro_en}
                  onChange={(e) => setProfile({ ...profile, intro_en: e.target.value })}
                  className="w-full px-3.5 py-2 bg-stone-900 border border-stone-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400 leading-relaxed"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-400 mb-1">Giới thiệu (Tiếng Việt)</label>
                <textarea
                  rows={3}
                  value={profile.intro_vi}
                  onChange={(e) => setProfile({ ...profile, intro_vi: e.target.value })}
                  className="w-full px-3.5 py-2 bg-stone-900 border border-stone-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400 leading-relaxed"
                />
              </div>
            </div>
          )}

          {/* TAB 2: LINKS MANAGER */}
          {activeTab === 'links' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-stone-800 gap-3">
                <div>
                  <h2 className="text-lg font-bold text-white font-serif">Manage Links</h2>
                  <p className="text-xs text-stone-400">Add, reorder, edit and organize links across sections.</p>
                </div>
                <button
                  onClick={() => setEditingLink({ section: 'products', title_en: '', url: '', is_active: true })}
                  className="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-stone-950 font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-md active:scale-95"
                >
                  <Plus className="w-4 h-4" />
                  Add New Link
                </button>
              </div>

              {/* Filter Tabs */}
              <div className="flex gap-2 border-b border-stone-800/80 pb-3 text-xs overflow-x-auto">
                {(['all', 'blogs', 'companies', 'products'] as const).map((sec) => (
                  <button
                    key={sec}
                    onClick={() => setFilterSection(sec)}
                    className={`px-3 py-1.5 rounded-lg capitalize transition-colors ${filterSection === sec ? 'bg-stone-800 text-amber-400 font-bold' : 'text-stone-400 hover:text-white'}`}
                  >
                    {sec === 'all' ? 'All Sections' : sec}
                  </button>
                ))}
              </div>

              {/* Links List */}
              <div className="space-y-2.5">
                {filteredLinks.map((link, idx) => (
                  <div
                    key={link.id}
                    className="p-3 bg-stone-900/90 border border-stone-800 rounded-2xl flex items-center justify-between gap-3 hover:border-stone-700 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-stone-800 flex items-center justify-center text-xs font-bold text-amber-400">
                        {link.section.substring(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-xs sm:text-sm font-semibold text-white truncate">
                          {link.title_en}
                        </h4>
                        <p className="text-[11px] text-stone-400 truncate font-mono">
                          {link.url}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleMove(idx, 'up')}
                        disabled={idx === 0}
                        className="p-1.5 text-stone-500 hover:text-white disabled:opacity-30 rounded-lg hover:bg-stone-800"
                        title="Move up"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleMove(idx, 'down')}
                        disabled={idx === links.length - 1}
                        className="p-1.5 text-stone-500 hover:text-white disabled:opacity-30 rounded-lg hover:bg-stone-800"
                        title="Move down"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setEditingLink(link)}
                        className="px-2.5 py-1 text-xs bg-stone-800 hover:bg-stone-700 text-stone-300 rounded-lg font-medium"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteLink(link.id)}
                        className="p-1.5 text-stone-500 hover:text-rose-400 rounded-lg hover:bg-stone-800"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 3: THEME CUSTOMIZER */}
          {activeTab === 'theme' && (
            <div className="space-y-6">
              <div className="pb-4 border-b border-stone-800">
                <h2 className="text-lg font-bold text-white font-serif">Theme Customizer</h2>
                <p className="text-xs text-stone-400">Select visual presets or apply custom CSS tokens.</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  { id: 'ivory', name: 'Warm Ivory', desc: 'Linktree classic beige (#F5EFEB) with serif fonts', color: '#F5EFEB', text: '#1E121C' },
                  { id: 'dark', name: 'Dark Aubergine', desc: 'Sample 02 deep plum (#2E1C2B) aesthetic with neon accents', color: '#2E1C2B', text: '#FFFFFF' },
                  { id: 'minimal', name: 'Minimal White', desc: 'Clean high-contrast editorial monochrome', color: '#FFFFFF', text: '#000000' },
                  { id: 'glass', name: 'Glassmorphic Frost', desc: 'Frosted blur translucency with subtle glows', color: '#18181B', text: '#E4E4E7' },
                ].map((t) => (
                  <div
                    key={t.id}
                    onClick={() => handleSetTheme(t.id)}
                    className={`p-4 rounded-2xl border-2 cursor-pointer transition-all duration-150 ${profile.theme === t.id ? 'border-amber-400 bg-stone-900 shadow-lg' : 'border-stone-800 bg-stone-950/60 hover:border-stone-700'}`}
                  >
                    <div className="w-full h-16 rounded-xl mb-3 flex items-center justify-center font-bold text-sm shadow-inner border border-black/10" style={{ backgroundColor: t.color, color: t.text }}>
                      {t.name}
                    </div>
                    <h3 className="font-bold text-sm text-white">{t.name}</h3>
                    <p className="text-xs text-stone-400 mt-0.5">{t.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 4: API & AGENTS CONSOLE */}
          {activeTab === 'keys' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-stone-800">
                <div>
                  <h2 className="text-lg font-bold text-white font-serif">AI Agents & API Keys</h2>
                  <p className="text-xs text-stone-400">Create programmatic API keys for Claude, MCP Server & CLI.</p>
                </div>
                <button
                  onClick={handleGenerateKey}
                  className="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-stone-950 font-bold text-xs rounded-xl flex items-center gap-1.5 transition-all shadow-md active:scale-95"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Generate New API Key
                </button>
              </div>

              {/* Newly revealed key notice */}
              {newKeyRevealed && (
                <div className="p-4 bg-amber-400/10 border-2 border-amber-400/40 rounded-2xl text-amber-200">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-xs text-amber-400 flex items-center gap-1.5">
                      <Key className="w-4 h-4" /> Save this Secret API Key now:
                    </span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(newKeyRevealed);
                        alert('API Key copied to clipboard!');
                      }}
                      className="px-2.5 py-1 bg-amber-400 text-stone-950 rounded-lg text-xs font-bold flex items-center gap-1"
                    >
                      <Copy className="w-3 h-3" /> Copy
                    </button>
                  </div>
                  <code className="block p-2.5 bg-black/60 rounded-xl font-mono text-xs text-amber-300 select-all break-all">
                    {newKeyRevealed}
                  </code>
                  <p className="mt-2 text-[11px] text-stone-400">
                    This token is only shown once. Use in CLI: <code>zuey login --key &lt;token&gt;</code>
                  </p>
                </div>
              )}

              {/* Active API Keys List */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-bold text-stone-400 uppercase tracking-wider font-mono">
                  Active API Keys ({apiKeys.length})
                </h3>
                {apiKeys.map((k) => (
                  <div
                    key={k.id}
                    className="p-3.5 bg-stone-900/90 border border-stone-800 rounded-2xl flex items-center justify-between gap-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-white">{k.name}</span>
                        <span className="text-[10px] bg-amber-400/20 text-amber-400 px-2 py-0.5 rounded-full font-mono">
                          {k.role}
                        </span>
                      </div>
                      <p className="text-xs text-stone-500 font-mono mt-0.5">
                        Prefix: {k.key_prefix} • Created: {new Date(k.created_at).toLocaleDateString()}
                      </p>
                    </div>

                    <button
                      onClick={() => handleRevokeKey(k.id)}
                      className="px-3 py-1.5 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 rounded-lg transition-colors border border-rose-900/50"
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>

              {/* CLI & MCP integration quick instructions */}
              <div className="p-4 bg-stone-900 border border-stone-800 rounded-2xl text-xs text-stone-300 space-y-2">
                <h4 className="font-bold text-white flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-400" /> Connecting AI Agents via MCP
                </h4>
                <p className="text-stone-400 text-[11px] leading-relaxed">
                  Add this MCP server block to your <code>claude_desktop_config.json</code> or Cursor MCP settings:
                </p>
                <pre className="p-3 bg-black rounded-xl font-mono text-[11px] text-amber-300 overflow-x-auto">
{JSON.stringify({
  mcpServers: {
    "zuey-me": {
      url: "https://zuey.me/api/mcp",
      headers: {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Right Phone Mockup Preview (Hidden on small screens unless toggled) */}
        <aside className={`w-[400px] border-l border-stone-800 bg-stone-900/30 p-6 flex flex-col items-center justify-center flex-shrink-0 ${showPreviewMobile ? 'fixed inset-0 z-40 bg-stone-950 w-full' : 'hidden lg:flex'}`}>
          {showPreviewMobile && (
            <button
              onClick={() => setShowPreviewMobile(false)}
              className="absolute top-4 right-4 p-2 bg-stone-800 text-white rounded-full lg:hidden"
            >
              ✕
            </button>
          )}

          <div className="w-[320px] h-[640px] bg-[#F5EFEB] rounded-[44px] shadow-2xl border-[10px] border-stone-800 overflow-hidden flex flex-col relative">
            {/* Phone Notch */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-5 bg-stone-800 rounded-b-xl z-20" />

            {/* Embedded Live Web Preview */}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col items-center pt-8 text-stone-900">
              <div className="w-16 h-16 rounded-full overflow-hidden border-2 border-stone-300 mb-2 shadow-xs">
                <img src={profile.avatar_url} alt="avatar" className="w-full h-full object-cover" />
              </div>
              <h3 className="font-bold text-base font-serif">{profile.name}</h3>
              <p className="text-[10px] text-stone-600 text-center line-clamp-2 mt-1 px-2">
                {profile.intro_en}
              </p>

              <div className="w-full mt-4 space-y-2">
                {links.slice(0, 6).map((l) => (
                  <div key={l.id} className="w-full py-2 px-3 bg-white rounded-full border border-stone-300 text-left flex items-center gap-2 shadow-xs">
                    <div className="w-6 h-6 rounded-full bg-stone-100 flex-shrink-0 text-[9px] flex items-center justify-center font-bold">
                      {l.section.substring(0, 1).toUpperCase()}
                    </div>
                    <span className="text-[11px] font-semibold text-stone-800 truncate">
                      {l.title_en}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <span className="text-[11px] text-stone-500 font-mono mt-3">
            Real-time Phone Preview
          </span>
        </aside>
      </div>

      {/* Add / Edit Link Modal Dialog */}
      {editingLink && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-stone-900 border border-stone-800 rounded-3xl p-6 shadow-2xl">
            <h3 className="text-base font-bold text-white font-serif mb-4">
              {editingLink.id ? 'Edit Link' : 'Add New Link'}
            </h3>

            <form onSubmit={handleSaveLink} className="space-y-3">
              <div>
                <label className="block text-xs text-stone-400 mb-1">Section</label>
                <select
                  value={editingLink.section}
                  onChange={(e) => setEditingLink({ ...editingLink, section: e.target.value as 'blogs' | 'companies' | 'products' | 'socials' })}
                  className="w-full px-3 py-2 bg-stone-950 border border-stone-800 rounded-xl text-xs text-white"
                >
                  <option value="blogs">Blogs</option>
                  <option value="companies">Companies (Found by me!)</option>
                  <option value="products">Products & Tools</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-stone-400 mb-1">Title (English)</label>
                <input
                  type="text"
                  required
                  value={editingLink.title_en || ''}
                  onChange={(e) => setEditingLink({ ...editingLink, title_en: e.target.value })}
                  className="w-full px-3 py-2 bg-stone-950 border border-stone-800 rounded-xl text-xs text-white"
                />
              </div>

              <div>
                <label className="block text-xs text-stone-400 mb-1">Tiêu đề (Tiếng Việt)</label>
                <input
                  type="text"
                  value={editingLink.title_vi || ''}
                  onChange={(e) => setEditingLink({ ...editingLink, title_vi: e.target.value })}
                  className="w-full px-3 py-2 bg-stone-950 border border-stone-800 rounded-xl text-xs text-white"
                />
              </div>

              <div>
                <label className="block text-xs text-stone-400 mb-1">URL</label>
                <input
                  type="url"
                  required
                  value={editingLink.url || ''}
                  onChange={(e) => setEditingLink({ ...editingLink, url: e.target.value })}
                  className="w-full px-3 py-2 bg-stone-950 border border-stone-800 rounded-xl text-xs text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-xs text-stone-400 mb-1">Subtitle / Tagline</label>
                <input
                  type="text"
                  value={editingLink.subtitle_en || ''}
                  onChange={(e) => setEditingLink({ ...editingLink, subtitle_en: e.target.value })}
                  className="w-full px-3 py-2 bg-stone-950 border border-stone-800 rounded-xl text-xs text-white"
                />
              </div>

              <div className="flex gap-2 pt-4 border-t border-stone-800">
                <button
                  type="button"
                  onClick={() => setEditingLink(null)}
                  className="flex-1 py-2 text-xs text-stone-400 hover:text-white rounded-xl bg-stone-800 font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 text-xs text-stone-950 font-bold rounded-xl bg-amber-400 hover:bg-amber-300"
                >
                  Save Link
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
