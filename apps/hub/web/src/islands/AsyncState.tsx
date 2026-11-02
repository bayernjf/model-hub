import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2 } from 'lucide-react';

/**
 * Unified loading / empty / error three-state component (UIUX P2 #8).
 *
 * Shared contract across model-hub, ops-console and atlas list pages:
 * exactly one of loading / error / empty is shown; otherwise children render.
 * Styling consumes the @bayjf/console-ui token palette.
 */
export interface AsyncStateProps {
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  loadingText?: string;
  emptyText?: string;
  errorText?: string;
  /** Shown under the error message; rendered as a primary button when provided. */
  onRetry?: () => void;
  children?: ReactNode;
}

export default function AsyncState({
  loading,
  error,
  empty,
  loadingText = '加载中…',
  emptyText = '暂无数据',
  errorText = '加载失败',
  onRetry,
  children,
}: AsyncStateProps) {
  if (loading) {
    return (
      <div className="async-state" role="status">
        <Loader2 className="spin async-state__icon" size={18} />
        <span className="async-state__text">{loadingText}</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="async-state async-state--error" role="alert">
        <AlertTriangle className="async-state__icon" size={18} />
        <div className="async-state__body">
          <span className="async-state__text">
            {errorText}：{error}
          </span>
          {onRetry && (
            <button className="btn btn--primary async-state__retry" onClick={onRetry}>
              重试
            </button>
          )}
        </div>
      </div>
    );
  }
  if (empty) {
    return (
      <div className="async-state" role="status">
        <Inbox className="async-state__icon" size={18} />
        <span className="async-state__text">{emptyText}</span>
      </div>
    );
  }
  return children;
}
