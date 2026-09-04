import React from 'react';

interface LanguageSwitchProps {
  currentLang: 'en' | 'vi';
  onChange: (lang: 'en' | 'vi') => void;
  className?: string;
}

export const LanguageSwitch: React.FC<LanguageSwitchProps> = ({
  currentLang,
  onChange,
  className = '',
}) => {
  return (
    <div className={`inline-flex items-center p-1 bg-stone-200/70 backdrop-blur-sm rounded-full border border-stone-300/60 shadow-xs ${className}`}>
      <button
        onClick={() => onChange('en')}
        className={`px-2.5 py-1 text-xs font-semibold rounded-full transition-all duration-150 ${
          currentLang === 'en'
            ? 'bg-white text-stone-900 shadow-sm'
            : 'text-stone-500 hover:text-stone-900'
        }`}
        aria-label="Switch to English"
      >
        EN
      </button>
      <button
        onClick={() => onChange('vi')}
        className={`px-2.5 py-1 text-xs font-semibold rounded-full transition-all duration-150 ${
          currentLang === 'vi'
            ? 'bg-white text-stone-900 shadow-sm'
            : 'text-stone-500 hover:text-stone-900'
        }`}
        aria-label="Chuyển sang Tiếng Việt"
      >
        VI
      </button>
    </div>
  );
};
