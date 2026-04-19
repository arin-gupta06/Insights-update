const palette = ['#3B6D11', '#BA7517', '#185FA5', '#534AB7', '#993C1D', '#0F6E56', '#1a6e6e', '#b58a2a'];
const CACHE_KEY = 'chronos_live_snapshot_v2';
const PROXY_MODE_KEY = 'chronos_proxy_mode_v1';
const HOSTED_PROXY_BASE = '/api';
const LOCAL_PROXY_BASE = 'http://127.0.0.1:8787';
const NETWORK_TIMEOUT_MS = 15000;
const PERIOD_CONFIG = {
  '7d': { label: 'Last 7 days', days: 7 },
  '30d': { label: 'Last 30 days', days: 30 },
  '180d': { label: 'Last 6 months', days: 180 },
  '365d': { label: 'Last 12 months', days: 365 },
  all: { label: 'All time', days: null }
};

let latestSnapshot = null;
let localProxyAvailable = false;
let activeProxyMode = 'none';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return new Intl.NumberFormat().format(value);
}

function formatSigned(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return `${value >= 0 ? '+' : ''}${formatNumber(value)}`;
}

function shortDate(isoDate) {
  if (!isoDate) return 'N/A';
  const date = new Date(isoDate);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function shortDateFromUnix(unixSeconds) {
  if (!unixSeconds) return 'N/A';
  return shortDate(new Date(unixSeconds * 1000).toISOString());
}

function shortDateTime(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  return date.toLocaleString();
}

function initials(text) {
  const safe = (text || 'NA').replace(/[^a-zA-Z0-9]/g, ' ').trim();
  if (!safe) return 'NA';
  const parts = safe.split(/\s+/).slice(0, 2);
  return parts.map((item) => item[0].toUpperCase()).join('');
}

function setStatus(message, severity) {
  const el = document.getElementById('liveStatus');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('warn', 'error');
  if (severity === 'warn') el.classList.add('warn');
  if (severity === 'error') el.classList.add('error');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setAuthHint(value) {
  setText('authModeHint', value);
}

function saveSnapshotToCache(snapshot) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore cache write failures.
  }
}

function loadSnapshotFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseRepoSlug(inputValue) {
  const raw = (inputValue || '').trim();
  if (!raw) throw new Error('Repository URL is required.');

  let slug = raw;
  if (raw.includes('github.com')) {
    let url;
    try {
      url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    } catch {
      throw new Error('Invalid GitHub repository URL.');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) throw new Error('Provide a valid repo path like owner/repo.');
    slug = `${parts[0]}/${parts[1]}`;
  }

  slug = slug.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new Error('Repository must be in owner/repo format.');
  }
  return slug;
}

function sanitizeToken(rawToken) {
  return String(rawToken || '')
    .trim()
    .replace(/^(bearer|token)\s+/i, '')
    .trim();
}

function normalizeProxyMode(mode) {
  if (mode === 'hosted' || mode === 'local' || mode === 'none') return mode;
  return 'none';
}

async function probeProxyHealth(mode) {
  const healthUrl = mode === 'hosted'
    ? `${HOSTED_PROXY_BASE}/health`
    : `${LOCAL_PROXY_BASE}/health`;

  try {
    const response = await fetchJsonWithTimeout(healthUrl, { cache: 'no-store' }, 2500);
    if (!response.ok) return null;
    const text = await response.text();
    const payload = parseJsonText(text) || {};
    return {
      ok: true,
      tokenLoaded: Boolean(payload?.tokenLoaded),
      mode
    };
  } catch {
    return null;
  }
}

function getPreferredProxyMode() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const queryMode = params.get('proxy');
    if (queryMode) {
      const normalized = normalizeProxyMode(queryMode.toLowerCase());
      localStorage.setItem(PROXY_MODE_KEY, normalized);
      return normalized;
    }
  } catch {
    // Ignore malformed URL params and use storage fallback.
  }

  try {
    return normalizeProxyMode(localStorage.getItem(PROXY_MODE_KEY) || 'none');
  } catch {
    return 'none';
  }
}

function getSelectedPeriodKey() {
  const periodEl = document.getElementById('contribPeriod');
  return periodEl && PERIOD_CONFIG[periodEl.value] ? periodEl.value : '30d';
}

function getPeriodLabel(periodKey) {
  return (PERIOD_CONFIG[periodKey] || PERIOD_CONFIG['30d']).label;
}

function getPeriodCutoff(periodKey) {
  const config = PERIOD_CONFIG[periodKey] || PERIOD_CONFIG['30d'];
  if (!config.days) return null;
  return Date.now() - (config.days * 24 * 60 * 60 * 1000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitFailure(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('rate limit') || text.includes('x-ratelimit') || text.includes('api 429') || text.includes('api rate limit exceeded');
}

function isAuthFailure(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('api 401')
    || text.includes('bad credentials')
    || text.includes('requires authentication')
    || text.includes('api 403');
}

function explainRepoFailure(errors, tokenProvided, tokenStatus) {
  const list = Array.isArray(errors) ? errors : [];
  const first = list[0] || 'Unable to fetch repository details.';
  const hasRateLimit = list.some(isRateLimitFailure);
  const hasAuthFailure = list.some(isAuthFailure);

  if (tokenProvided && tokenStatus && tokenStatus.provided && !tokenStatus.accepted) {
    const reason = tokenStatus.message ? ` ${tokenStatus.message}` : '';
    return `Provided token is not accepted by GitHub.${reason} Check token value, token permissions, and org SSO authorization.`;
  }

  if (hasAuthFailure && tokenProvided) {
    return 'GitHub rejected the provided token for this repository scope (401/403). For a fine-grained PAT, explicitly grant access to ChronalLabs/ChronOS.';
  }

  if (hasRateLimit) {
    if (tokenProvided && tokenStatus && tokenStatus.accepted) {
      const resetSuffix = tokenStatus.reset
        ? ` Reset at ${new Date(tokenStatus.reset * 1000).toLocaleTimeString()}.`
        : '';
      return `Token is accepted, but API quota is exhausted (${formatNumber(tokenStatus.remaining)}/${formatNumber(tokenStatus.limit)} remaining).${resetSuffix}`;
    }
    return tokenProvided
      ? 'GitHub API request quota is exhausted for the current credentials. Wait for reset or switch token/proxy.'
      : 'GitHub API is currently rate-limited. Add a token and retry for live updates.';
  }

  if (hasAuthFailure && !tokenProvided) {
    return 'GitHub requires authentication for this request path. Add a token and retry.';
  }

  return first;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseJsonText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function ghFetchResponse(url, token) {
  if (localProxyAvailable && !token) {
    const proxyBase = activeProxyMode === 'hosted' ? `${HOSTED_PROXY_BASE}/github-proxy` : `${LOCAL_PROXY_BASE}/api`;
    const proxyLabel = activeProxyMode === 'hosted' ? 'Hosted proxy' : 'Local proxy';
    const proxyUrl = `${proxyBase}?url=${encodeURIComponent(url)}`;
    const response = await fetchJsonWithTimeout(proxyUrl, { cache: 'no-store' });
    if (!response.ok && response.status !== 202) {
      const text = await response.text();
      throw new Error(`${proxyLabel} error ${response.status}: ${text || 'unknown error'}`);
    }
    return response;
  }

  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `token ${token}`;

  return fetchJsonWithTimeout(url, { headers });
}

async function ghFetchResponseNoAuth(url) {
  return fetchJsonWithTimeout(url, { headers: { Accept: 'application/vnd.github+json' } });
}

function shouldRetryAsPublic(url, token, status, apiMessage) {
  if (!token) return false;
  if (status !== 401 && status !== 403) return false;
  if (!/^https:\/\/api\.github\.com\//i.test(String(url || ''))) return false;

  const text = String(apiMessage || '').toLowerCase();
  if (text.includes('rate limit') || text.includes('abuse')) return false;
  return true;
}

async function ghFetch(url, token) {
  const response = await ghFetchResponse(url, token);
  if (!response.ok) {
    const bodyText = await response.text();
    const body = parseJsonText(bodyText) || {};
    const apiMessage = body?.message || bodyText || 'unknown error';
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const resetText = reset ? ` Rate limit resets at ${new Date(Number(reset) * 1000).toLocaleTimeString()}.` : '';
    const authHint = token ? '' : ' Add a GitHub token in the optional field to increase rate limits.';

    if (response.status === 403 && String(apiMessage).toLowerCase().includes('resource not accessible by personal access token')) {
      if (shouldRetryAsPublic(url, token, response.status, apiMessage)) {
        const retry = await ghFetchResponseNoAuth(url);
        if (retry.ok) {
          const retryText = await retry.text();
          return parseJsonText(retryText);
        }
      }
      throw new Error(`GitHub API 403 for ${url}. Resource not accessible by personal access token. Grant this repository to your fine-grained token or use a classic PAT.`);
    }

    if (shouldRetryAsPublic(url, token, response.status, apiMessage)) {
      const retry = await ghFetchResponseNoAuth(url);
      if (retry.ok) {
        const retryText = await retry.text();
        return parseJsonText(retryText);
      }

      const retryBodyText = await retry.text();
      const retryBody = parseJsonText(retryBodyText) || {};
      const retryMessage = retryBody?.message || retryBodyText || 'unknown error';
      throw new Error(`GitHub API ${response.status} for ${url}. ${apiMessage}. Retry without token also failed (${retry.status}: ${retryMessage}).`);
    }

    const extra = remaining === '0' ? `${resetText}${authHint}` : authHint;
    throw new Error(`GitHub API ${response.status} for ${url}. ${apiMessage}.${extra}`.trim());
  }

  const text = await response.text();
  return parseJsonText(text);
}

async function validateTokenStatus(token) {
  if (!token) return { provided: false, accepted: false };

  try {
    const response = await fetchJsonWithTimeout('https://api.github.com/rate_limit', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${token}`
      }
    });

    const text = await response.text();
    const payload = parseJsonText(text) || {};
    if (!response.ok) {
      return {
        provided: true,
        accepted: false,
        status: response.status,
        message: payload?.message || text || `HTTP ${response.status}`
      };
    }

    const core = payload?.resources?.core || {};
    return {
      provided: true,
      accepted: true,
      limit: Number(core.limit || 0),
      remaining: Number(core.remaining || 0),
      reset: Number(core.reset || 0)
    };
  } catch (error) {
    return {
      provided: true,
      accepted: false,
      message: error?.message || 'Token validation request failed.'
    };
  }
}

async function ghFetchAllowAccepted(url, token) {
  const response = await ghFetchResponse(url, token);
  if (response.status === 202) {
    return { __pending: true };
  }
  if (!response.ok) {
    const text = await response.text();
    const payload = parseJsonText(text) || {};
    const apiMessage = payload?.message || text || 'unknown error';

    if (shouldRetryAsPublic(url, token, response.status, apiMessage)) {
      const retry = await ghFetchResponseNoAuth(url);
      if (retry.status === 202) return { __pending: true };
      if (retry.ok) {
        const retryText = await retry.text();
        return parseJsonText(retryText);
      }
    }

    throw new Error(`GitHub API ${response.status} for ${url}. ${apiMessage}`.trim());
  }
  const text = await response.text();
  return parseJsonText(text);
}

async function detectLocalProxy(token) {
  const tokenPresent = Boolean((token || '').trim());
  const preferredMode = getPreferredProxyMode();

  localProxyAvailable = false;
  activeProxyMode = 'none';

  const tokenInput = document.getElementById('tokenInput');

  const selectProxyMode = (mode, health) => {
    if (!health || !health.ok || !health.tokenLoaded) return false;
    localProxyAvailable = true;
    activeProxyMode = mode;
    return true;
  };

  if (preferredMode === 'hosted') {
    const hostedHealth = await probeProxyHealth('hosted');
    if (!selectProxyMode('hosted', hostedHealth)) {
      setAuthHint('Hosted proxy was requested but is unavailable or missing server token. Falling back to direct mode.');
    }
  } else if (preferredMode === 'local') {
    const localHealth = await probeProxyHealth('local');
    if (!selectProxyMode('local', localHealth)) {
      setAuthHint('Local proxy was requested but is unavailable or missing local token. Falling back to direct mode.');
    }
  } else {
    const [hostedHealth, localHealth] = await Promise.all([
      probeProxyHealth('hosted'),
      probeProxyHealth('local')
    ]);

    if (!selectProxyMode('hosted', hostedHealth)) {
      selectProxyMode('local', localHealth);
    }
  }

  if (activeProxyMode === 'hosted') {
    setAuthHint('Auth mode: hosted proxy (manual). If unavailable, switch to direct mode by removing ?proxy=hosted or set ?proxy=none.');
    if (tokenInput) tokenInput.placeholder = 'Hosted proxy active: token not required here';
  } else if (activeProxyMode === 'local') {
    setAuthHint('Auth mode: local proxy (manual). If unavailable, switch to direct mode by removing ?proxy=local or set ?proxy=none.');
    if (tokenInput) tokenInput.placeholder = 'Local proxy active: token not required here';
  } else {
    if (!tokenPresent && preferredMode === 'none') {
      setAuthHint('Auth mode: direct browser mode. No healthy proxy detected; paste token here or configure hosted/local proxy token.');
    } else {
      setAuthHint('Auth mode: direct browser mode. Paste token here, or use hosted/local proxy mode.');
    }
    if (tokenInput) tokenInput.placeholder = 'Optional GitHub token (raises rate limits)';
  }
}

function renderLanguages(languageMap) {
  const bar = document.getElementById('langBar');
  const grid = document.getElementById('langGrid');
  if (!bar || !grid) return [];

  const entries = Object.entries(languageMap || {});
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (!total) {
    bar.innerHTML = '<div style="width:100%; background:#888780; border-radius:6px;"></div>';
    grid.innerHTML = '<div class="lang-item"><div class="lang-dot" style="background:#888780;"></div><span class="lang-name">Unavailable</span><span class="lang-pct">0%</span></div>';
    return [];
  }

  const top = entries
    .map(([name, bytes]) => ({ name, pct: (bytes / total) * 100 }))
    .sort((a, b) => b.pct - a.pct);

  const topVisible = top.slice(0, 7);
  const remainderPct = Math.max(0, 100 - topVisible.reduce((sum, item) => sum + item.pct, 0));
  bar.innerHTML = topVisible
    .map((item, idx) => {
      const radiusStart = idx === 0 ? '6px 0 0 6px' : '0';
      const radiusEnd = idx === topVisible.length - 1 && remainderPct < 0.05 ? '0 6px 6px 0' : '0';
      const radius = idx === 0 && topVisible.length === 1 ? '6px' : `${radiusStart} ${radiusEnd}`;
      return `<div style="width:${item.pct.toFixed(2)}%; background:${palette[idx % palette.length]}; border-radius:${radius};"></div>`;
    })
    .join('');

  if (remainderPct >= 0.05) {
    bar.innerHTML += `<div style="width:${remainderPct.toFixed(2)}%; background:#888780; border-radius:0 6px 6px 0;"></div>`;
  }

  grid.innerHTML = topVisible
    .map((item, idx) => `
      <div class="lang-item">
        <div class="lang-dot" style="background:${palette[idx % palette.length]};"></div>
        <span class="lang-name">${escapeHtml(item.name)}</span>
        <span class="lang-pct">${item.pct.toFixed(2)}%</span>
      </div>
    `)
    .join('');

  if (remainderPct >= 0.05) {
    grid.innerHTML += `
      <div class="lang-item">
        <div class="lang-dot" style="background:#888780;"></div>
        <span class="lang-name">Other</span>
        <span class="lang-pct">${remainderPct.toFixed(2)}%</span>
      </div>
    `;
  }

  const lead = document.getElementById('languageLead');
  if (lead) {
    lead.textContent = `Language mix refreshed from GitHub API. Top ${Math.min(topVisible.length, 7)} languages represent ${topVisible.reduce((s, v) => s + v.pct, 0).toFixed(2)}% of code.`;
  }

  return top;
}

function normalizeContributors(contributorsRaw, contributorStatsRaw) {
  const byKey = new Map();
  (contributorsRaw || []).forEach((item, idx) => {
    const key = item?.login || item?.name || `anon_${idx}`;
    byKey.set(key, {
      key,
      login: item?.login || null,
      displayName: item?.login || item?.name || `Contributor ${idx + 1}`,
      avatarUrl: item?.avatar_url || null,
      profileUrl: item?.html_url || null,
      lifetimeCommits: Number(item?.contributions || 0),
      weeks: []
    });
  });

  (contributorStatsRaw || []).forEach((item, idx) => {
    const key = item?.author?.login || null;
    if (!key) return;
    const existing = byKey.get(key) || {
      key,
      login: key,
      displayName: key,
      avatarUrl: item?.author?.avatar_url || null,
      profileUrl: item?.author?.html_url || null,
      lifetimeCommits: Number(item?.total || 0),
      weeks: []
    };

    existing.avatarUrl = existing.avatarUrl || item?.author?.avatar_url || null;
    existing.profileUrl = existing.profileUrl || item?.author?.html_url || null;
    existing.lifetimeCommits = Math.max(existing.lifetimeCommits || 0, Number(item?.total || 0));
    existing.weeks = Array.isArray(item?.weeks)
      ? item.weeks.map((week) => ({
        w: Number(week?.w || 0),
        c: Number(week?.c || 0),
        a: Number(week?.a || 0),
        d: Number(week?.d || 0)
      }))
      : [];
    byKey.set(key, existing);
  });

  return Array.from(byKey.values());
}

function buildContributorAnalytics(contributorBase, periodKey) {
  const cutoff = getPeriodCutoff(periodKey);
  const periodLabel = getPeriodLabel(periodKey);
  const timelineMap = new Map();

  const rows = (contributorBase || []).map((contributor) => {
    const filteredWeeks = (contributor.weeks || []).filter((week) => {
      if (!cutoff) return true;
      return (week.w * 1000) >= cutoff;
    });

    let commits = filteredWeeks.reduce((sum, week) => sum + week.c, 0);
    let additions = filteredWeeks.reduce((sum, week) => sum + week.a, 0);
    let deletions = filteredWeeks.reduce((sum, week) => sum + week.d, 0);

    if (periodKey === 'all' && commits === 0 && contributor.lifetimeCommits > 0) {
      commits = contributor.lifetimeCommits;
    }

    filteredWeeks.forEach((week) => {
      const existing = timelineMap.get(week.w) || { w: week.w, commits: 0, additions: 0, deletions: 0 };
      existing.commits += week.c;
      existing.additions += week.a;
      existing.deletions += week.d;
      timelineMap.set(week.w, existing);
    });

    const activeWeeks = filteredWeeks.filter((week) => week.c > 0).length;
    const latestWeek = filteredWeeks.reduce((max, week) => (week.c > 0 && week.w > max ? week.w : max), 0);

    return {
      key: contributor.key,
      login: contributor.login,
      displayName: contributor.displayName,
      avatarUrl: contributor.avatarUrl,
      profileUrl: contributor.profileUrl,
      commits,
      additions,
      deletions,
      net: additions - deletions,
      activeWeeks,
      lastActiveWeek: latestWeek
    };
  })
    .filter((row) => row.commits > 0 || row.additions > 0 || row.deletions > 0 || periodKey === 'all')
    .sort((a, b) => {
      if (b.commits !== a.commits) return b.commits - a.commits;
      if (b.net !== a.net) return b.net - a.net;
      return a.displayName.localeCompare(b.displayName);
    })
    .map((row, idx) => ({ ...row, rank: idx + 1 }));

  const totals = rows.reduce((acc, row) => {
    acc.commits += row.commits;
    acc.additions += row.additions;
    acc.deletions += row.deletions;
    return acc;
  }, { commits: 0, additions: 0, deletions: 0 });
  totals.net = totals.additions - totals.deletions;
  totals.contributors = rows.length;
  totals.activeContributors = rows.filter((row) => row.commits > 0).length;

  const topFourCommits = rows.slice(0, 4).reduce((sum, row) => sum + row.commits, 0);
  const topFourShare = totals.commits > 0 ? (topFourCommits / totals.commits) * 100 : 0;

  const timeline = Array.from(timelineMap.values()).sort((a, b) => a.w - b.w);

  return {
    periodKey,
    periodLabel,
    cutoff,
    rows,
    totals,
    topFourShare,
    timeline,
    generatedAt: new Date().toISOString()
  };
}

function renderContributorCards(analytics) {
  const grid = document.getElementById('contribGrid');
  if (!grid) return;

  const ranked = (analytics?.rows || []).slice(0, 6);
  if (!ranked.length) {
    grid.innerHTML = `
      <div class="contrib-card">
        <div class="contrib-avatar" style="background:#ede9fe; color:#5b21b6;">NA</div>
        <div class="contrib-info">
          <div class="contrib-name">Contributor data unavailable</div>
          <div class="contrib-role">No contributor data available in selected period.</div>
          <div class="contrib-bar-bg"><div class="contrib-bar-fill" style="width:0%; background:#5b21b6;"></div></div>
          <div class="contrib-count">Try a wider time window and refresh again.</div>
        </div>
      </div>`;
    return;
  }

  const maxCount = ranked[0].commits || 1;
  grid.innerHTML = ranked
    .map((contributor, idx) => {
      const width = Math.max(6, ((contributor.commits || 0) / maxCount) * 100);
      const color = palette[idx % palette.length];
      const bg = `${color}22`;
      const role = `${formatNumber(contributor.additions)} added / ${formatNumber(contributor.deletions)} removed / net ${formatSigned(contributor.net)}`;
      return `
        <div class="contrib-card">
          <div class="contrib-avatar" style="background:${bg}; color:${color};">${initials(contributor.displayName)}</div>
          <div class="contrib-info">
            <div class="contrib-name">#${contributor.rank} ${escapeHtml(contributor.displayName)}</div>
            <div class="contrib-role">${escapeHtml(role)}</div>
            <div class="contrib-bar-bg"><div class="contrib-bar-fill" style="width:${width.toFixed(2)}%; background:${color};"></div></div>
            <div class="contrib-count">${formatNumber(contributor.commits)} commits in ${escapeHtml(analytics.periodLabel)}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderContributorTable(analytics) {
  const tbody = document.getElementById('contribTableBody');
  if (!tbody) return;

  if (!analytics?.rows?.length) {
    tbody.innerHTML = `
      <tr>
        <td class="issue-num-cell">-</td>
        <td class="issue-title-cell">No contributors found for ${escapeHtml(analytics?.periodLabel || 'selected period')}.</td>
        <td class="issue-author-cell">-</td>
        <td class="issue-author-cell">-</td>
        <td class="issue-author-cell">-</td>
        <td class="issue-author-cell">-</td>
        <td class="issue-author-cell">-</td>
        <td class="issue-date-cell">-</td>
      </tr>`;
    return;
  }

  tbody.innerHTML = analytics.rows.map((row) => {
    const contributorCell = row.profileUrl
      ? `<a href="${escapeHtml(row.profileUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.displayName)}</a>`
      : escapeHtml(row.displayName);

    return `
      <tr>
        <td class="issue-num-cell">${row.rank}</td>
        <td class="issue-title-cell">${contributorCell}</td>
        <td class="issue-author-cell">${formatNumber(row.commits)}</td>
        <td class="issue-author-cell">${formatNumber(row.additions)}</td>
        <td class="issue-author-cell">${formatNumber(row.deletions)}</td>
        <td class="issue-author-cell">${formatSigned(row.net)}</td>
        <td class="issue-author-cell">${formatNumber(row.activeWeeks)}</td>
        <td class="issue-date-cell">${shortDateFromUnix(row.lastActiveWeek)}</td>
      </tr>
    `;
  }).join('');
}

function renderContributorVisuals(analytics) {
  const commitBars = document.getElementById('contribCommitBars');
  const netBars = document.getElementById('contribNetBars');
  const timelineBars = document.getElementById('contribTimelineBars');

  const rows = analytics?.rows || [];
  const topCommitRows = rows.slice(0, 12);
  if (commitBars) {
    if (!topCommitRows.length) {
      commitBars.innerHTML = '<div class="viz-empty">No commit ranking data in this period.</div>';
    } else {
      const maxCommits = Math.max(1, ...topCommitRows.map((row) => row.commits));
      commitBars.innerHTML = topCommitRows.map((row, idx) => `
        <div class="viz-row">
          <span class="viz-row-label">#${row.rank} ${escapeHtml(row.displayName)}</span>
          <span class="viz-row-value">${formatNumber(row.commits)}</span>
          <div class="viz-track"><div class="viz-fill" style="width:${((row.commits / maxCommits) * 100).toFixed(2)}%; background:${palette[idx % palette.length]};"></div></div>
        </div>
      `).join('');
    }
  }

  if (netBars) {
    const topNetRows = rows
      .slice()
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .slice(0, 12);

    if (!topNetRows.length) {
      netBars.innerHTML = '<div class="viz-empty">No net contribution data in this period.</div>';
    } else {
      const maxAbsNet = Math.max(1, ...topNetRows.map((row) => Math.abs(row.net)));
      netBars.innerHTML = topNetRows.map((row) => `
        <div class="viz-row">
          <span class="viz-row-label">${escapeHtml(row.displayName)}</span>
          <span class="viz-row-value">${formatSigned(row.net)}</span>
          <div class="viz-track"><div class="viz-fill" style="width:${((Math.abs(row.net) / maxAbsNet) * 100).toFixed(2)}%; background:${row.net >= 0 ? 'var(--green)' : 'var(--accent)'};"></div></div>
        </div>
      `).join('');
    }
  }

  if (timelineBars) {
    const timeline = (analytics?.timeline || []).slice(-16);
    if (!timeline.length) {
      timelineBars.innerHTML = '<div class="viz-empty">No timeline data in this period.</div>';
    } else {
      const maxCommits = Math.max(1, ...timeline.map((entry) => entry.commits));
      timelineBars.innerHTML = timeline.map((entry, idx) => `
        <div class="viz-row">
          <span class="viz-row-label">${shortDateFromUnix(entry.w)}</span>
          <span class="viz-row-value">${formatNumber(entry.commits)} commits</span>
          <div class="viz-track"><div class="viz-fill" style="width:${((entry.commits / maxCommits) * 100).toFixed(2)}%; background:${palette[idx % palette.length]};"></div></div>
        </div>
      `).join('');
    }
  }
}

function renderIssues(issues) {
  const tbody = document.getElementById('issuesTbody');
  if (!tbody) return;

  if (!issues || !issues.length) {
    tbody.innerHTML = '<tr><td class="issue-num-cell">-</td><td class="issue-title-cell">No open issues returned</td><td class="issue-author-cell">-</td><td class="issue-author-cell">-</td><td class="issue-date-cell">-</td></tr>';
    return;
  }

  tbody.innerHTML = issues.map((issue) => `
    <tr>
      <td class="issue-num-cell">#${issue.number}</td>
      <td class="issue-title-cell">${escapeHtml(issue.title)}</td>
      <td class="issue-author-cell">${escapeHtml(issue.user?.login || 'unknown')}</td>
      <td class="issue-author-cell">${escapeHtml(issue.state || 'unknown')}</td>
      <td class="issue-date-cell">${shortDate(issue.created_at)}</td>
    </tr>
  `).join('');
}

function renderPrs(prs) {
  const tbody = document.getElementById('prsTbody');
  if (!tbody) return;

  if (!prs || !prs.length) {
    tbody.innerHTML = '<tr><td class="issue-num-cell">-</td><td class="issue-title-cell">No pull requests returned</td><td class="issue-author-cell">-</td><td class="issue-author-cell">-</td><td class="issue-date-cell">-</td></tr>';
    return;
  }

  tbody.innerHTML = prs.map((pr) => `
    <tr>
      <td class="issue-num-cell">#${pr.number}</td>
      <td class="issue-title-cell">${escapeHtml(pr.title)}</td>
      <td class="issue-author-cell">${escapeHtml(pr.user?.login || 'unknown')}</td>
      <td class="issue-author-cell">${pr.merged_at ? 'merged' : escapeHtml(pr.state || 'unknown')}</td>
      <td class="issue-date-cell">${shortDate(pr.updated_at)}</td>
    </tr>
  `).join('');
}

function renderInsightVisuals(counts, topContributors, commitTotal) {
  const toNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const pipelineBars = document.getElementById('pipelineBars');
  const contribMiniBars = document.getElementById('contribMiniBars');

  const pipelineData = [
    { label: 'Open Issues', value: toNumber(counts?.issuesOpen), color: 'var(--accent)' },
    { label: 'Closed Issues', value: toNumber(counts?.issuesClosed), color: 'var(--blue)' },
    { label: 'Open PRs', value: toNumber(counts?.prsOpen), color: 'var(--gold)' },
    { label: 'Closed PRs', value: toNumber(counts?.prsClosed), color: 'var(--green)' }
  ];

  if (pipelineBars) {
    const maxPipeline = Math.max(1, ...pipelineData.map((item) => item.value));
    const hasPipelineData = pipelineData.some((item) => item.value > 0);
    pipelineBars.innerHTML = hasPipelineData
      ? pipelineData.map((item) => `
        <div class="viz-row">
          <span class="viz-row-label">${item.label}</span>
          <span class="viz-row-value">${formatNumber(item.value)}</span>
          <div class="viz-track"><div class="viz-fill" style="width:${((item.value / maxPipeline) * 100).toFixed(2)}%; background:${item.color};"></div></div>
        </div>
      `).join('')
      : '<div class="viz-empty">No issue or PR totals available yet.</div>';
  }

  if (contribMiniBars) {
    const ranked = (topContributors || []).slice(0, 5);
    if (!ranked.length) {
      contribMiniBars.innerHTML = '<div class="viz-empty">Contributor chart becomes available after live refresh.</div>';
    } else {
      const maxContrib = Math.max(1, ...ranked.map((item) => item.contributions || 0));
      contribMiniBars.innerHTML = ranked.map((item, idx) => {
        const color = palette[idx % palette.length];
        const width = Math.max(7, ((item.contributions || 0) / maxContrib) * 100);
        return `
          <div class="viz-row">
            <span class="viz-row-label">${escapeHtml(item.login || item.name || 'unknown')}</span>
            <span class="viz-row-value">${formatNumber(item.contributions || 0)}</span>
            <div class="viz-track"><div class="viz-fill" style="width:${width.toFixed(2)}%; background:${color};"></div></div>
          </div>
        `;
      }).join('');
    }
  }

  function setMeter(fillId, valueId, ratio) {
    const fill = document.getElementById(fillId);
    const value = document.getElementById(valueId);
    if (!fill || !value) return;
    if (ratio === null || ratio === undefined || Number.isNaN(ratio)) {
      fill.style.width = '0%';
      value.textContent = 'N/A';
      return;
    }
    const bounded = Math.max(0, Math.min(100, ratio));
    fill.style.width = `${bounded.toFixed(1)}%`;
    value.textContent = `${bounded.toFixed(1)}%`;
  }

  const issuesKnown = typeof counts?.issuesOpen === 'number' && typeof counts?.issuesClosed === 'number';
  const prsKnown = typeof counts?.prsOpen === 'number' && typeof counts?.prsClosed === 'number';
  const issueTotal = issuesKnown ? counts.issuesOpen + counts.issuesClosed : 0;
  const prTotal = prsKnown ? counts.prsOpen + counts.prsClosed : 0;

  const issueClosureRate = issueTotal > 0 ? (counts.issuesClosed / issueTotal) * 100 : null;
  const prClosureRate = prTotal > 0 ? (counts.prsClosed / prTotal) * 100 : null;
  const top4 = (topContributors || []).slice(0, 4).reduce((sum, item) => sum + (item.contributions || 0), 0);
  const concentrationRate = commitTotal > 0 ? (top4 / commitTotal) * 100 : null;

  setMeter('vizIssueClosureFill', 'vizIssueClosureValue', issueClosureRate);
  setMeter('vizPrClosureFill', 'vizPrClosureValue', prClosureRate);
  setMeter('vizConcentrationFill', 'vizConcentrationValue', concentrationRate);

  const narrative = document.getElementById('vizNarrative');
  if (narrative) {
    const issueText = issueClosureRate === null ? 'issue rate unavailable' : `issue closure ${issueClosureRate.toFixed(1)}%`;
    const prText = prClosureRate === null ? 'PR rate unavailable' : `PR closure ${prClosureRate.toFixed(1)}%`;
    const concentrationText = concentrationRate === null ? 'concentration unavailable' : `top 4 share ${concentrationRate.toFixed(1)}%`;
    narrative.textContent = `Live signal: ${issueText}, ${prText}, ${concentrationText}.`;
  }
}

function renderContributorSignals(analytics, counts) {
  const periodLabel = analytics?.periodLabel || getPeriodLabel(getSelectedPeriodKey());
  setText('contribScopeLabel', periodLabel);
  setText('contributorLead', `Contributor ranking from GitHub API for ${periodLabel} (${formatNumber(analytics?.rows?.length || 0)} contributors).`);
  setText('contributionSignal', `Contribution concentration (${periodLabel}): top 4 contributors account for ${(analytics?.topFourShare || 0).toFixed(1)}% of visible commits.`);
  setText('deliverySignal', `Delivery snapshot: ${formatNumber(counts?.prsOpen)} open PRs, ${formatNumber(counts?.prsClosed)} closed PRs, and ${formatNumber(counts?.issuesOpen)} open issues.`);
}

function buildDetailedReportHtml(data) {
  const analytics = data.contributorAnalytics || {
    periodLabel: 'N/A',
    totals: { contributors: 0, activeContributors: 0, commits: 0, additions: 0, deletions: 0, net: 0 },
    rows: [],
    timeline: []
  };

  const languageRows = (data.languages || [])
    .slice(0, 15)
    .map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${item.pct.toFixed(2)}%</td></tr>`)
    .join('');

  const contributorRows = analytics.rows
    .map((item) => `<tr><td>${item.rank}</td><td>${escapeHtml(item.displayName)}</td><td>${formatNumber(item.commits)}</td><td>${formatNumber(item.additions)}</td><td>${formatNumber(item.deletions)}</td><td>${formatSigned(item.net)}</td><td>${formatNumber(item.activeWeeks)}</td><td>${shortDateFromUnix(item.lastActiveWeek)}</td></tr>`)
    .join('');

  const issueRows = (data.openIssues || [])
    .slice(0, 12)
    .map((item) => `<li><strong>#${item.number}</strong> ${escapeHtml(item.title)} <span>(${escapeHtml(item.user?.login || 'unknown')})</span></li>`)
    .join('');

  const prRows = (data.recentPrs || [])
    .slice(0, 12)
    .map((item) => `<li><strong>#${item.number}</strong> ${escapeHtml(item.title)} <span>(${escapeHtml(item.user?.login || 'unknown')})</span></li>`)
    .join('');

  const timeline = (analytics.timeline || []).slice(-20);
  const maxTimelineCommit = Math.max(1, ...timeline.map((item) => item.commits || 0));
  const timelineHtml = timeline.length
    ? timeline.map((item) => `<div class="timeline-row"><span>${shortDateFromUnix(item.w)}</span><div class="bar-wrap"><div class="bar" style="width:${((item.commits / maxTimelineCommit) * 100).toFixed(2)}%;"></div></div><strong>${formatNumber(item.commits)}</strong></div>`).join('')
    : '<div class="empty">No timeline data available.</div>';

  const topCommitter = analytics.rows[0];
  const topNet = analytics.rows.slice().sort((a, b) => b.net - a.net)[0];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(data.repoSlug)} - Detailed Contributor Summary</title>
<style>
  :root { --ink:#0d0d0d; --paper:#f7f5f0; --accent:#c84b1f; --soft:#eeeae2; --border:rgba(13,13,13,0.14); --green:#2a6e42; --blue:#1a3a6e; }
  * { box-sizing:border-box; }
  body { margin:0; font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; background:var(--paper); color:var(--ink); line-height:1.6; }
  .hero { background:var(--ink); color:var(--paper); padding:36px; }
  .hero h1 { margin:0 0 8px; font-size:34px; letter-spacing:-0.02em; }
  .hero p { margin:0; opacity:0.82; }
  .wrap { max-width:1100px; margin:0 auto; padding:24px 20px 40px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:10px; margin-bottom:20px; }
  .card { background:var(--soft); border:1px solid var(--border); border-radius:10px; padding:12px; }
  .label { font-size:11px; letter-spacing:0.08em; text-transform:uppercase; opacity:0.7; margin-bottom:7px; }
  .value { font-size:24px; font-weight:700; letter-spacing:-0.02em; }
  h2 { font-size:22px; margin:24px 0 10px; }
  h3 { font-size:18px; margin:14px 0 8px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--border); font-size:13px; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; background:var(--soft); }
  ul { background:#fff; border:1px solid var(--border); padding:12px 16px; border-radius:10px; margin:0; }
  li { margin:7px 0; }
  li span { color:#555; }
  .timeline { background:#fff; border:1px solid var(--border); border-radius:10px; padding:12px; }
  .timeline-row { display:grid; grid-template-columns: 120px 1fr auto; gap:10px; align-items:center; margin:8px 0; font-size:12px; }
  .bar-wrap { background:#e7e2d8; height:8px; border-radius:99px; overflow:hidden; }
  .bar { height:100%; border-radius:99px; background:var(--blue); }
  .highlights { background:#fff; border:1px solid var(--border); border-radius:10px; padding:12px 16px; }
  .highlights p { margin:6px 0; font-size:14px; }
  .empty { font-size:13px; color:#666; }
  .foot { margin-top:26px; font-size:13px; color:#666; }
</style>
</head>
<body>
  <section class="hero">
    <h1>${escapeHtml(data.repoSlug)} Detailed Contributor Summary</h1>
    <p>Generated ${escapeHtml(data.generatedAt || shortDateTime(new Date().toISOString()))} | Window: ${escapeHtml(analytics.periodLabel)}</p>
  </section>
  <main class="wrap">
    <section class="grid">
      <div class="card"><div class="label">Stars</div><div class="value">${formatNumber(data.repo?.stargazers_count)}</div></div>
      <div class="card"><div class="label">Forks</div><div class="value">${formatNumber(data.repo?.forks_count)}</div></div>
      <div class="card"><div class="label">Active Contributors</div><div class="value">${formatNumber(analytics.totals.activeContributors)}</div></div>
      <div class="card"><div class="label">Commits (${escapeHtml(analytics.periodLabel)})</div><div class="value">${formatNumber(analytics.totals.commits)}</div></div>
      <div class="card"><div class="label">Lines Added</div><div class="value">${formatNumber(analytics.totals.additions)}</div></div>
      <div class="card"><div class="label">Lines Removed</div><div class="value">${formatNumber(analytics.totals.deletions)}</div></div>
      <div class="card"><div class="label">Net Lines</div><div class="value">${formatSigned(analytics.totals.net)}</div></div>
      <div class="card"><div class="label">Top 4 Share</div><div class="value">${(analytics.topFourShare || 0).toFixed(1)}%</div></div>
    </section>

    <h2>Key Highlights</h2>
    <div class="highlights">
      <p><strong>Top Committer:</strong> ${topCommitter ? `${escapeHtml(topCommitter.displayName)} (${formatNumber(topCommitter.commits)} commits)` : 'N/A'}</p>
      <p><strong>Highest Net Contribution:</strong> ${topNet ? `${escapeHtml(topNet.displayName)} (${formatSigned(topNet.net)} lines)` : 'N/A'}</p>
      <p><strong>Issue/PR Snapshot:</strong> ${formatNumber(data.counts?.issuesOpen)} open issues, ${formatNumber(data.counts?.issuesClosed)} closed issues, ${formatNumber(data.counts?.prsOpen)} open PRs, ${formatNumber(data.counts?.prsClosed)} closed PRs.</p>
    </div>

    <h2>Contributor Ranking</h2>
    <table>
      <thead><tr><th>Rank</th><th>Contributor</th><th>Commits</th><th>Added</th><th>Removed</th><th>Net</th><th>Active Weeks</th><th>Last Active</th></tr></thead>
      <tbody>${contributorRows || '<tr><td colspan="8">No contributor data</td></tr>'}</tbody>
    </table>

    <h2>Contribution Timeline</h2>
    <div class="timeline">${timelineHtml}</div>

    <h2>Language Distribution</h2>
    <table>
      <thead><tr><th>Language</th><th>Share</th></tr></thead>
      <tbody>${languageRows || '<tr><td colspan="2">No language data</td></tr>'}</tbody>
    </table>

    <h2>Latest Open Issues</h2>
    <ul>${issueRows || '<li>No issue data</li>'}</ul>

    <h2>Recently Updated Pull Requests</h2>
    <ul>${prRows || '<li>No PR data</li>'}</ul>

    <p class="foot">Source: GitHub API. Repo: ${escapeHtml(data.repo?.html_url || `https://github.com/${data.repoSlug}`)}</p>
  </main>
</body>
</html>`;
}

function triggerDownload(filename, content) {
  const blob = new Blob([content], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function toCacheSnapshot(snapshot) {
  return {
    repo: snapshot.repo,
    repoSlug: snapshot.repoSlug,
    generatedAt: snapshot.generatedAt,
    counts: snapshot.counts,
    languageMap: snapshot.languageMap,
    openIssues: snapshot.openIssues,
    recentPrs: snapshot.recentPrs,
    contributorAnalytics: snapshot.contributorAnalytics,
    errors: snapshot.errors || []
  };
}

function renderLanguagesFromSnapshot(snapshot) {
  const map = snapshot?.languageMap || {};
  return renderLanguages(map);
}

function applySnapshot(snapshot, sourceLabel) {
  if (!snapshot) return;

  const repo = snapshot.repo || {};
  const repoSlug = snapshot.repoSlug || repo.full_name || parseRepoSlug(document.getElementById('repoInput')?.value || '');
  const counts = snapshot.counts || {};
  const openIssues = Array.isArray(snapshot.openIssues) ? snapshot.openIssues : [];
  const recentPrs = Array.isArray(snapshot.recentPrs) ? snapshot.recentPrs : [];

  const selectedPeriod = getSelectedPeriodKey();
  const analytics = Array.isArray(snapshot.contributorBase)
    ? buildContributorAnalytics(snapshot.contributorBase, selectedPeriod)
    : (snapshot.contributorAnalytics || buildContributorAnalytics([], selectedPeriod));

  setText('coverStars', formatNumber(repo.stargazers_count));
  setText('coverOpenIssues', formatNumber(counts.issuesOpen));
  setText('coverCommits', formatNumber(analytics.totals.commits));
  setText('coverRepoBadge', repo.full_name ? `github.com/${repo.full_name}` : `github.com/${repoSlug}`);

  setText('metricStars', formatNumber(repo.stargazers_count));
  setText('metricForks', formatNumber(repo.forks_count));
  setText('metricWatchers', formatNumber(repo.subscribers_count));
  setText('metricCommits', formatNumber(analytics.totals.commits));
  setText('metricOpenIssues', formatNumber(counts.issuesOpen));
  setText('metricOpenPrs', formatNumber(counts.prsOpen));

  setText('catIssuesOpen', formatNumber(counts.issuesOpen));
  setText('catIssuesClosed', formatNumber(counts.issuesClosed));
  setText('catPrOpen', formatNumber(counts.prsOpen));
  setText('catPrClosed', formatNumber(counts.prsClosed));

  const trackedTotal = [counts.issuesOpen, counts.issuesClosed, counts.prsOpen, counts.prsClosed].every((num) => typeof num === 'number')
    ? counts.issuesOpen + counts.issuesClosed + counts.prsOpen + counts.prsClosed
    : null;
  setText('catTracked', formatNumber(trackedTotal));

  const languages = renderLanguagesFromSnapshot(snapshot);
  renderContributorCards(analytics);
  renderContributorVisuals(analytics);
  renderContributorTable(analytics);
  renderIssues(openIssues);
  renderPrs(recentPrs);

  const topContributors = analytics.rows.map((row) => ({ login: row.displayName, contributions: row.commits }));
  renderInsightVisuals(counts, topContributors, analytics.totals.commits);
  renderContributorSignals(analytics, counts);

  setText('issuesLead', `Latest snapshot for ${repoSlug}: ${formatNumber(counts.issuesOpen)} open issues, ${formatNumber(counts.issuesClosed)} closed issues, ${formatNumber(counts.prsOpen)} open PRs, ${formatNumber(counts.prsClosed)} closed PRs.`);
  const openIssueNum = typeof counts.issuesOpen === 'number' ? counts.issuesOpen : null;
  const openPrNum = typeof counts.prsOpen === 'number' ? counts.prsOpen : null;
  if (openIssueNum === null || openPrNum === null) {
    setText('issueInsight', 'Interpretation: partial data currently available. Add a GitHub token and refresh for full issue/PR balance.');
  } else {
    setText('issueInsight', `Interpretation: current issue-PR ratio suggests ${openIssueNum > openPrNum ? 'a larger issue backlog than active PR queue' : 'strong alignment between issue intake and active PR flow'}.`);
  }

  if (snapshot.generatedAt) {
    setText('latestRefreshNote', `Latest refresh: ${snapshot.generatedAt}. Data source: ${sourceLabel || 'GitHub API'} | Scope: ${analytics.periodLabel}.`);
    setText('footerRefreshStamp', `Data sourced from github.com/${repoSlug} (API refresh: ${snapshot.generatedAt})`);
  }

  if (repoSlug) {
    setText('coverRepoBadge', `github.com/${repoSlug}`);
  }

  latestSnapshot = {
    ...snapshot,
    repoSlug,
    languages,
    contributorAnalytics: analytics
  };
}

function applyPeriodFilter() {
  if (!latestSnapshot) return;

  if (Array.isArray(latestSnapshot.contributorBase) && latestSnapshot.contributorBase.length) {
    applySnapshot(latestSnapshot, 'GitHub API');
    setStatus(`Updated contributor analytics for ${getPeriodLabel(getSelectedPeriodKey())}.`);
    return;
  }

  setStatus('Cached snapshot loaded without weekly contributor data. Refresh Insights to enable time-window filtering.', 'warn');
}

async function fetchAllContributors(baseUrl, safeFetch) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = await safeFetch(`${baseUrl}/contributors?per_page=100&page=${page}&anon=1`);
    if (!Array.isArray(payload)) break;
    all.push(...payload);
    if (payload.length < 100) break;
  }

  const deduped = new Map();
  all.forEach((item, idx) => {
    const key = item?.login || item?.name || `anon_${idx}`;
    if (!deduped.has(key)) deduped.set(key, item);
  });
  return Array.from(deduped.values());
}

async function fetchContributorStatsWithRetry(baseUrl, token, notices) {
  const url = `${baseUrl}/stats/contributors`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const payload = await ghFetchAllowAccepted(url, token);
      if (payload && payload.__pending) {
        await delay(900 + (attempt * 300));
        continue;
      }
      if (Array.isArray(payload)) return payload;
      return [];
    } catch (error) {
      notices.push('Contributor line-level weekly stats are temporarily unavailable; commit ranking is still up to date.');
      return [];
    }
  }

  notices.push('Contributor line-level weekly stats are still being prepared by GitHub; retry in a moment for added/removed line totals.');
  return [];
}

async function refreshInsights() {
  const refreshBtn = document.getElementById('refreshBtn');
  const token = sanitizeToken(document.getElementById('tokenInput')?.value);
  const tokenProvided = Boolean(token);
  let tokenStatus = { provided: false, accepted: false };
  let repoSlug;

  try {
    repoSlug = parseRepoSlug(document.getElementById('repoInput')?.value);
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }

  refreshBtn.disabled = true;
  try {
    setStatus('Refreshing live repository data...');
    await detectLocalProxy(token);
    tokenStatus = await validateTokenStatus(token);
    const effectiveToken = tokenProvided && tokenStatus.accepted ? token : '';

    if (tokenProvided && tokenStatus.accepted) {
      const resetNote = tokenStatus.reset ? `, resets ${new Date(tokenStatus.reset * 1000).toLocaleTimeString()}` : '';
      setAuthHint(`Auth mode: direct token verified (${formatNumber(tokenStatus.remaining)}/${formatNumber(tokenStatus.limit)} remaining${resetNote}).`);
    } else if (tokenProvided && !tokenStatus.accepted) {
      const fallbackSource = localProxyAvailable
        ? `${activeProxyMode} proxy`
        : 'public GitHub API';
      setAuthHint(`Auth mode: token rejected by GitHub${tokenStatus.status ? ` (${tokenStatus.status})` : ''}. Falling back to ${fallbackSource}. Check token permissions and org SSO.`);
    }

    const base = `https://api.github.com/repos/${repoSlug}`;
    const now = new Date();
    const errors = [];
    const notices = [];

    async function safeFetch(url) {
      try {
        return await ghFetch(url, effectiveToken);
      } catch (error) {
        if (error?.name === 'AbortError') {
          errors.push(`Request timed out: ${url}`);
        } else {
          errors.push(error?.message || `Request failed: ${url}`);
        }
        return null;
      }
    }

    const [repo, languagesMap, contributorsRaw, contributorStatsRaw, issuesOpenRes, issuesClosedRes, prsOpenRes, prsClosedRes, issuesRaw, prsRaw] = await Promise.all([
      safeFetch(base),
      safeFetch(`${base}/languages`),
      fetchAllContributors(base, safeFetch),
      fetchContributorStatsWithRetry(base, effectiveToken, notices),
      safeFetch(`https://api.github.com/search/issues?q=repo:${repoSlug}+is:issue+is:open`),
      safeFetch(`https://api.github.com/search/issues?q=repo:${repoSlug}+is:issue+is:closed`),
      safeFetch(`https://api.github.com/search/issues?q=repo:${repoSlug}+is:pr+is:open`),
      safeFetch(`https://api.github.com/search/issues?q=repo:${repoSlug}+is:pr+is:closed`),
      safeFetch(`${base}/issues?state=open&per_page=20&sort=created&direction=desc`),
      safeFetch(`${base}/pulls?state=all&per_page=20&sort=updated&direction=desc`)
    ]);

    const cachedSnapshot = (latestSnapshot && latestSnapshot.repoSlug === repoSlug)
      ? latestSnapshot
      : loadSnapshotFromCache();

    if (!repo) {
      const failureMessage = explainRepoFailure(errors, tokenProvided, tokenStatus);
      if (cachedSnapshot && cachedSnapshot.repoSlug === repoSlug) {
        applySnapshot(cachedSnapshot, 'cached snapshot');
        setStatus(`${failureMessage} Showing last successful snapshot.`, 'warn');
      } else {
        setStatus(failureMessage, 'error');
      }
      return;
    }

    const fallbackCounts = cachedSnapshot?.counts || {};
    const openIssues = (issuesRaw || []).filter((item) => !item.pull_request);
    const recentPrs = prsRaw || cachedSnapshot?.recentPrs || [];
    const contributorBase = normalizeContributors(contributorsRaw || [], contributorStatsRaw || []);

    const issuesOpenCount = issuesOpenRes?.total_count ?? fallbackCounts.issuesOpen ?? repo.open_issues_count ?? null;
    const issuesClosedCount = issuesClosedRes?.total_count ?? fallbackCounts.issuesClosed ?? null;
    const prsOpenCount = prsOpenRes?.total_count ?? fallbackCounts.prsOpen ?? null;
    const prsClosedCount = prsClosedRes?.total_count ?? fallbackCounts.prsClosed ?? null;

    const refreshedAt = now.toLocaleString();
    setText('coverDate', now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));

    const snapshot = {
      repo,
      repoSlug,
      generatedAt: refreshedAt,
      counts: {
        issuesOpen: issuesOpenCount,
        issuesClosed: issuesClosedCount,
        prsOpen: prsOpenCount,
        prsClosed: prsClosedCount
      },
      languageMap: languagesMap || cachedSnapshot?.languageMap || {},
      contributorBase,
      openIssues: openIssues.length ? openIssues : (cachedSnapshot?.openIssues || []),
      recentPrs,
      notices,
      errors
    };

    applySnapshot(snapshot, 'GitHub API');
    saveSnapshotToCache(toCacheSnapshot(latestSnapshot));

    if (errors.length) {
      const modeHint = activeProxyMode === 'hosted'
        ? 'Check Vercel environment token if this persists.'
        : activeProxyMode === 'local'
          ? 'Check local proxy token file if this persists.'
          : 'Add a token or use hosted/local proxy for full refresh.';
      setStatus(`Refresh completed with partial data (${errors.length} API warning(s)). ${modeHint}`, 'warn');
    } else if (notices.length) {
      setStatus(`Refresh complete. ${notices[0]}`);
    } else {
      setStatus('Refresh complete. Full contributor analytics loaded successfully.');
    }
  } catch (error) {
    setStatus(error?.message || 'Unexpected error while refreshing insights.', 'error');
  } finally {
    refreshBtn.disabled = false;
  }
}

function downloadDetailedReport() {
  if (!latestSnapshot) {
    setStatus('Run Refresh Insights first, then download.', 'error');
    return;
  }

  const content = buildDetailedReportHtml(latestSnapshot);
  const safeName = latestSnapshot.repoSlug.replace('/', '_');
  const datePart = new Date().toISOString().slice(0, 10);
  triggerDownload(`${safeName}_detailed_summary_${datePart}.html`, content);
  setStatus('Detailed summary report downloaded to your local system.');
}

document.getElementById('refreshBtn')?.addEventListener('click', refreshInsights);
document.getElementById('downloadBtn')?.addEventListener('click', downloadDetailedReport);
document.getElementById('contribPeriod')?.addEventListener('change', applyPeriodFilter);

window.addEventListener('load', async () => {
  const cached = loadSnapshotFromCache();
  if (cached) {
    try {
      applySnapshot(cached, 'cached snapshot');
      setStatus('Loaded cached snapshot. Click Refresh Insights when you want a new live pull.');
    } catch {
      // Ignore malformed cache and continue with live refresh.
    }
  } else {
    setStatus('Ready. Click Refresh Insights to pull the latest repository data.');
  }
  await detectLocalProxy(document.getElementById('tokenInput')?.value || '');
});
