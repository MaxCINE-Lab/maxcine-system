export const colors = {
  navigation: '#121315',
  navigationHover: '#1B1D21',
  navigationActive: '#262A2F',
  canvas: '#F5F6F8',
  surface: '#FFFFFF',
  surfaceMuted: '#F9FAFB',
  border: '#E5E7EB',
  borderStrong: '#D1D5DB',
  text: '#111827',
  textSecondary: '#6B7280',
  placeholder: '#9CA3AF',
  focus: '#52667D',
  focusRing: 'rgba(82, 102, 125, 0.18)',
  success: '#166534',
  successSurface: '#ECFDF3',
  warning: '#9A5B00',
  warningSurface: '#FFF7E6',
  danger: '#B42318',
  dangerSurface: '#FEF2F2',
  info: '#365978',
  infoSurface: '#EFF6FF',
  white: '#FFFFFF'
} as const;

export const spacing = { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 8: '32px', 10: '40px', 12: '48px' } as const;
export const radius = { control: '8px', card: '12px', large: '16px', pill: '999px' } as const;
export const typography = { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', body: '14px', small: '12px', title: '32px', heading: '18px' } as const;
export const shadow = { card: '0 1px 2px rgba(17, 24, 39, 0.04)', floating: '0 12px 30px rgba(17, 24, 39, 0.12)' } as const;

export const theme = { colors, spacing, radius, typography, shadow } as const;

const cssVariables: Record<string, string> = {
  '--mc-nav': colors.navigation,
  '--mc-nav-hover': colors.navigationHover,
  '--mc-nav-active': colors.navigationActive,
  '--mc-canvas': colors.canvas,
  '--mc-surface': colors.surface,
  '--mc-surface-muted': colors.surfaceMuted,
  '--mc-border': colors.border,
  '--mc-border-strong': colors.borderStrong,
  '--mc-text': colors.text,
  '--mc-text-secondary': colors.textSecondary,
  '--mc-placeholder': colors.placeholder,
  '--mc-focus': colors.focus,
  '--mc-focus-ring': colors.focusRing,
  '--mc-success': colors.success,
  '--mc-success-surface': colors.successSurface,
  '--mc-warning': colors.warning,
  '--mc-warning-surface': colors.warningSurface,
  '--mc-danger': colors.danger,
  '--mc-danger-surface': colors.dangerSurface,
  '--mc-info': colors.info,
  '--mc-info-surface': colors.infoSurface,
  '--mc-white': colors.white,
  '--mc-space-1': spacing[1],
  '--mc-space-2': spacing[2],
  '--mc-space-3': spacing[3],
  '--mc-space-4': spacing[4],
  '--mc-space-5': spacing[5],
  '--mc-space-6': spacing[6],
  '--mc-space-8': spacing[8],
  '--mc-space-10': spacing[10],
  '--mc-space-12': spacing[12],
  '--mc-radius-control': radius.control,
  '--mc-radius-card': radius.card,
  '--mc-radius-large': radius.large,
  '--mc-radius-pill': radius.pill,
  '--mc-font': typography.fontFamily,
  '--mc-shadow-card': shadow.card,
  '--mc-shadow-floating': shadow.floating
};

export function installTheme(): void {
  for (const [name, value] of Object.entries(cssVariables)) document.documentElement.style.setProperty(name, value);
}
