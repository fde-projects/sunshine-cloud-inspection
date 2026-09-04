import { Grid } from 'antd';
import type { DrawerProps } from 'antd';

/** 桌面固定宽度，手机全宽（适配抽屉 / 宽弹层） */
export function useDrawerWidth(desktopWidth = 720): number | string {
  const screens = Grid.useBreakpoint();
  return screens.md ? desktopWidth : '100%';
}

type MobileDrawerOpts = {
  /** 手机底部抽屉高度，默认 90% */
  mobileHeight?: string | number;
};

/**
 * 侧栏抽屉：桌面固定宽靠右；手机改为底部大抽屉，避免多层侧栏难用。
 * 用法：`<Drawer {...useMobileDrawer(760)} ... />`
 */
export function useMobileDrawer(
  desktopWidth = 720,
  opts?: MobileDrawerOpts,
): Pick<DrawerProps, 'width' | 'placement' | 'height' | 'className'> {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  if (isMobile) {
    return {
      width: '100%',
      placement: 'bottom',
      height: opts?.mobileHeight ?? '90%',
      className: 'admin-mobile-sheet',
    };
  }
  return {
    width: desktopWidth,
    placement: 'right',
  };
}
