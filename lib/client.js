// client.js — dsh-qoder-connect 客户端半体（设置卡：双区登录 / 额度 / 领积分 / 模型数）
// 铁律：exports.inject=["slots","locale"] 双声明 + hooks 全在条件 return 前 + 贡献点全 guard。

const SETTINGS_KEY = 'qoder-connect';
const LOCALE_NS = 'settings.qoder-connect';
const BUNDLE_NAME = 'dsh-qoder-connect';
const PLUGIN_API = '/plugins/dsh-qoder-connect';

window.__ModuleLoader__.load({
  id: BUNDLE_NAME,
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const module = { exports: {} };
    const exports = module.exports;

    const zh = {
      title: 'Qoder 反代',
      desc: '在 DSH 内使用 Qoder / Qoder CN 的积分与模型，并自动领取每日积分。',
      product_intl: 'Qoder（国际版）',
      product_cn: 'Qoder CN（国内版）',
      login: '设备码登录',
      login_open: '打开授权页',
      login_polling: '等待授权确认…',
      login_done: '登录成功',
      login_fail: '登录失败',
      logout: '退出登录',
      refresh_quota: '刷新额度',
      claim_now: '立即领取',
      claim_auto: '每日自动领取已启用（30 分钟轮询）',
      nickname: '账号',
      plan: '套餐',
      models: '模型数',
      quota: '额度',
      session: '会话',
      session_active: '有效',
      session_inactive: '未建立',
      not_logged_in: '未登录',
      credits: '积分',
      expires: '到期',
      never: '—',
      loading: '加载中…',
      status_ok: '适配器运行中',
      status_off: '适配器未注册',
      error: '错误',
    };
    const en = {
      title: 'Qoder Proxy',
      desc: 'Use Qoder / Qoder CN credits and models inside DSH, with automatic daily credit claiming.',
      product_intl: 'Qoder (International)',
      product_cn: 'Qoder CN (China)',
      login: 'Device Login',
      login_open: 'Open Auth Page',
      login_polling: 'Waiting for authorization…',
      login_done: 'Signed in',
      login_fail: 'Sign-in failed',
      logout: 'Sign out',
      refresh_quota: 'Refresh Quota',
      claim_now: 'Claim Now',
      claim_auto: 'Auto claim enabled (30 min polling)',
      nickname: 'Account',
      plan: 'Plan',
      models: 'Models',
      quota: 'Quota',
      session: 'Session',
      session_active: 'Active',
      session_inactive: 'Not established',
      not_logged_in: 'Not signed in',
      credits: 'credits',
      expires: 'Expires',
      never: '—',
      loading: 'Loading…',
      status_ok: 'Adapter running',
      status_off: 'Adapter not registered',
      error: 'Error',
    };

    function guardClientContribution(label, fn) {
      try {
        const r = fn();
        if (r && typeof r.catch === 'function') {
          r.catch((e) => console.error(`[${NS}] ${label} async error:`, e));
        }
        return r;
      } catch (e) {
        console.error(`[${NS}] ${label} error:`, e);
        return undefined;
      }
    }

    async function api(path, opts) {
      const resp = await fetch(`${PLUGIN_API}${path}`, {
        method: opts?.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j?.error || `HTTP ${resp.status}`);
      return j;
    }

    function fmtTime(ms) {
      if (!ms) return '—';
      try {
        return new Date(ms).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch {
        return '—';
      }
    }

    const pill = {
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: 999,
      fontSize: 12,
      lineHeight: '18px',
      background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.12))',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      marginRight: 8,
    };
    const pillOk = {
      ...pill,
      background: 'color-mix(in srgb, var(--dsw-alias-state-success, #22a06b) 18%, transparent)',
      color: 'var(--dsw-alias-state-success, #22a06b)',
    };
    const card = {
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
      borderRadius: 12,
      padding: '14px 16px',
      marginBottom: 12,
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      boxShadow: 'var(--dsw-shadow-lv2, none)',
    };
    const btn = {
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
      borderRadius: 8,
      padding: '5px 12px',
      fontSize: 13,
      cursor: 'pointer',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      marginRight: 8,
    };
    const btnPrimary = {
      ...btn,
      background: 'var(--dsw-alias-button-primary-fill, #4f6ef2)',
      borderColor: 'transparent',
      color: 'var(--dsw-alias-label-primary-foreground, #fff)',
    };
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 };
    const label = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', marginRight: 4 };

    function QuotaSegments({ quota, t }) {
      const segs = Array.isArray(quota?.segments) ? quota.segments : [];
      if (!segs.length) return h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', marginTop: 4 } }, quota?.error ? `${t('error')}: ${quota.error}` : t('not_logged_in'));
      return h('div', { style: row },
        segs.map((s, i) => h('span', { key: s.key || i, style: pill },
          `${s.key === 'userQuota' ? t('quota') : s.key === 'addOnQuota' ? '+' : s.key}: ${s.remaining ?? '?'} / ${s.total ?? '?'} ${s.unit || t('credits')}`)));
    }

    function VariantCard({ v, t, onAction }) {
      const [busy, setBusy] = React.useState(false);
      const [loginUrl, setLoginUrl] = React.useState(null);
      const [pollMsg, setPollMsg] = React.useState(null);

      React.useEffect(() => {
        if (!loginUrl) return undefined;
        let cancelled = false;
        const product = v.product;
        const poll = async () => {
          for (let i = 0; i < 60 && !cancelled; i++) {
            try {
              const r = await api('/login/poll', { method: 'POST', body: { product } });
              if (r.state === 'done') {
                setPollMsg(t('login_done'));
                setLoginUrl(null);
                onAction();
                setTimeout(() => setPollMsg(null), 3000);
                return;
              }
              if (r.state === 'error') {
                setPollMsg(`${t('login_fail')}: ${r.message || ''}`);
                setLoginUrl(null);
                return;
              }
            } catch { /* keep polling */ }
            await new Promise((r2) => setTimeout(r2, 5000));
          }
          if (!cancelled) { setPollMsg(t('login_fail')); setLoginUrl(null); }
        };
        poll();
        return () => { cancelled = true; };
      }, [loginUrl]);

      const startLogin = async () => {
        setBusy(true);
        setPollMsg(null);
        try {
          const r = await api('/login/start', { method: 'POST', body: { product: v.product } });
          if (r.ok && r.url) {
            setLoginUrl(r.url);
            try { window.open(r.url, '_blank', 'noopener'); } catch { /* ignore */ }
          } else {
            setPollMsg(`${t('login_fail')}: ${r.error || ''}`);
          }
        } catch (e) {
          setPollMsg(`${t('login_fail')}: ${e.message}`);
        } finally {
          setBusy(false);
        }
      };

      const doAction = async (path, body) => {
        setBusy(true);
        try {
          await api(path, { method: 'POST', body: body || { product: v.product } });
          onAction();
        } catch { /* ignore */ } finally {
          setBusy(false);
        }
      };

      const c = v.creds || {};
      const loggedIn = c.hasOAuth || c.hasPat;
      const quota = v.quota;

      return h('div', { style: card },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('div', { style: { fontWeight: 600, fontSize: 14 } },
            v.product === 'cn' ? t('product_cn') : t('product_intl')),
          h('span', { style: v.adapterActive ? pillOk : pill }, v.adapterActive ? t('status_ok') : t('status_off'))),
        h('div', { style: row },
          h('span', { style: label }, t('nickname')),
          h('span', null, c.nickname || t('not_logged_in')),
          c.plan ? h('span', { style: pill }, c.plan) : null,
          h('span', { style: label }, t('models')),
          h('span', null, v.modelCount ?? '—')),
        h('div', { style: row },
          h('span', { style: label }, t('session')),
          h('span', { style: c.sessionActive ? pillOk : pill }, c.sessionActive ? t('session_active') : t('session_inactive')),
          h('span', { style: label }, t('expires')),
          h('span', null, fmtTime(c.expireTime))),
        h('div', { style: row },
          h('span', { style: label }, t('quota')),
          h(QuotaSegments, { quota, t })),
        v.lastClaim ? h('div', { style: row },
          h('span', { style: label }, `${t('claim_now')}`),
          h('span', { style: { fontSize: 12 } }, `${fmtTime(v.lastClaim.at)} · ${v.lastClaim.detail || ''}`)) : null,
        h('div', { style: row },
          loggedIn
            ? [
              h('button', { key: 'claim', style: btnPrimary, disabled: busy, onClick: () => doAction('/claim') }, t('claim_now')),
              h('button', { key: 'quota', style: btn, disabled: busy, onClick: () => doAction('/quota') }, t('refresh_quota')),
              h('button', { key: 'logout', style: btn, disabled: busy, onClick: () => doAction('/logout') }, t('logout')),
            ]
            : [
              h('button', { key: 'login', style: btnPrimary, disabled: busy, onClick: startLogin }, t('login')),
            ]),
        loginUrl ? h('div', { style: { ...row, flexDirection: 'column', alignItems: 'flex-start' } },
          h('a', { href: loginUrl, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: 12, wordBreak: 'break-all' } }, t('login_open')),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' } }, pollMsg || t('login_polling'))) : null,
        !loginUrl && pollMsg ? h('div', { style: { ...row, fontSize: 12 } }, pollMsg) : null,
      );
    }

    function QoderCard(props) {
      const { t } = props;
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);

      const load = React.useCallback(async () => {
        try {
          const j = await api('/status');
          setData(j);
          setError(null);
        } catch (e) {
          setError(e.message);
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        load();
        const iv = setInterval(load, 60000);
        return () => clearInterval(iv);
      }, [load]);

      const variants = data?.variants ? Object.entries(data.variants).map(([id, v]) => {
        const cat = id === 'qoder-cn' ? 14 : 2;
        return { ...v, id, modelCount: cat };
      }) : [];

      return h('div', null,
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('title')),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 10 } }, t('desc')),
        h('div', { style: { fontSize: 12, marginBottom: 10, color: 'var(--dsw-alias-brand-primary, #4f6ef2)' } }, t('claim_auto')),
        error ? h('div', { style: { ...row, color: 'var(--dsw-alias-state-error-primary, #d64545)' } }, `${t('error')}: ${error}`) : null,
        loading ? h('div', { style: row }, t('loading')) : null,
        variants.map((v) => h(VariantCard, {
          key: v.id, v, t,
          onAction: load,
        })),
      );
    }

    function apply(ctx) {
      const localeNs = guardClientContribution('locale.register', () => ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'qoder-connect.locale'));
      void localeNs;

      const t = ctx.locale.bind(LOCALE_NS);

      guardClientContribution('slots.settings.plugin.item', () => ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: SETTINGS_KEY,
        priority: 30,
        inject: () => ({ t }),
      }, QoderCard)));

      guardClientContribution('slots.plugins.bundle.config', () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_NAME,
        locale: LOCALE_NS,
      }, QoderCard)));
    }

    exports.name = 'dsh-qoder-connect-client';
    exports.inject = ['slots', 'locale'];
    exports.apply = apply;
    return module.exports;
  },
});
