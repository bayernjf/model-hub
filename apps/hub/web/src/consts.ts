export const APP_TITLE = 'model-hub';

export interface NavItem {
  href: string;
  label: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/providers', label: '厂商' },
  { href: '/models', label: '模型' },
  { href: '/projects', label: '项目' },
  { href: '/assignments', label: '分配' },
  { href: '/costs', label: '成本' },
];
