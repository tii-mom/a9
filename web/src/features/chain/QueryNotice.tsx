import type { QueryState } from '../../lib/api';

export function QueryNotice({ query, lang, label }: { query: Pick<QueryState<unknown>, 'data' | 'error' | 'loading' | 'updatedAt' | 'refresh'>; lang: 'zh' | 'en'; label: string }) {
  if (!query.error && (query.data || !query.loading)) return null;
  const zh = lang === 'zh';
  return <div className={query.error ? 'chain-warn' : 'chain-empty'} role="status">
    <span>{label} · {query.error ? (query.data ? (zh ? '更新失败，显示上次数据' : 'Update failed; showing previous data') : (zh ? '暂时无法加载，金额未知' : 'Unavailable; amounts unknown')) : (zh ? '正在加载…' : 'Loading…')}</span>
    {query.updatedAt ? <span> · {zh ? '上次同步 ' : 'Last updated '}{new Date(query.updatedAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US')}</span> : null}
    {query.error ? <button className="btn ghost sm" type="button" onClick={query.refresh}>{zh ? '重试' : 'Retry'}</button> : null}
  </div>;
}
