window.createReportsModule = function () {
    return {
        reports: { summary: { summary: {}, top_models: [], top_users: [] }, users: { rows: [] }, groups: { rows: [] }, costs: { by_day: [], by_model: [] }, quotaEvents: { rows: [], breakdown: [] } },
        reportFilter: { range: '30d', limit: 100, metric: 'cost' },
        reportDetail: { open: false, type: '', title: '', data: null },

        metricValue(row) {
            return Number(row?.[this.reportFilter.metric] || 0);
        },
        formatMetricValue(row) {
            return this.reportFilter.metric === 'tokens' ? `${this.formatNumber(row?.tokens || 0)} tok` : '$' + Number(row?.cost || 0).toFixed(4);
        },
        rankedRows(rows) {
            return [...(rows || [])].sort((a, b) => this.metricValue(b) - this.metricValue(a));
        },
        async openReportDetail(type, id) {
            const headers = { 'x-admin-key': this.adminKey };
            const url = type === 'user'
                ? `/admin/reports/user/${encodeURIComponent(id)}?range=${this.reportFilter.range}`
                : type === 'group'
                    ? `/admin/reports/group/${encodeURIComponent(id)}?range=${this.reportFilter.range}`
                    : `/admin/reports/model/${encodeURIComponent(id)}?range=${this.reportFilter.range}`;
            const response = await fetch(url, { headers });
            this.reportDetail = { open: true, type, title: id, data: await response.json() };
        },
        openTimeDrilldown(day) {
            const rows = (this.reports.costs.by_day || []).filter(r => String(r.day).slice(0, 10) === String(day).slice(0, 10));
            this.reportDetail = { open: true, type: 'day', title: `Day ${this.formatDate(day)}`, data: { summary: rows[0] || {}, by_day: rows } };
        },
        openQuotaBreakdown(category) {
            const rows = (this.reports.quotaEvents.rows || []).filter(r => (r.denied_category || 'quota') === category);
            this.reportDetail = { open: true, type: 'quota', title: this.formatQuotaCategory(category), data: { summary: { requests: rows.length, tokens: 0, cost: 0 }, quota_events: rows } };
        },
        reportDetailRows() {
            const d = this.reportDetail.data || {};
            return d.by_model || d.by_user || d.members || [];
        },
        detailRowKey(row) { return row.model || row.user_id || row.day || JSON.stringify(row); },
        detailRowName(row) { return row.model || row.user_id || row.day || '-'; },
        reportDetailTimelineRows() {
            const d = this.reportDetail.data || {};
            return d.by_day || d.quota_events || [];
        },
        detailTimelineKey(row) { return row.day || row.id || JSON.stringify(row); },
        detailTimelineWhen(row) { return row.day ? this.formatDate(row.day) : this.formatDateTimeShort(row.started_at); },
        detailTimelineInfo(row) { return row.day ? 'Daily summary' : `${this.formatQuotaCategory(row.denied_category || 'quota')}: ${row.denied_reason || row.path || '-'}`; },
        detailTimelineMetric(row) { return row.day ? (this.reportFilter.metric === 'tokens' ? this.formatNumber(row.tokens) + ' tok' : '$' + Number(row.cost || 0).toFixed(4)) : String(row.status || ''); },
        barStyle(value, rows, field = 'cost') {
            const nums = (rows || []).map(r => Number(r?.[field] || 0));
            const max = Math.max(0, ...nums);
            const current = Number(value || 0);
            const width = max > 0 ? Math.max(2, (current / max) * 100) : 0;
            return `width:${width}%`;
        },
        formatTrend(value) {
            const n = Number(value || 0);
            const sign = n > 0 ? '+' : '';
            return `${sign}${n.toFixed(1)}% vs previous`;
        },
        metricLabel() {
            return this.reportFilter.metric === 'tokens' ? 'Token' : 'Cost';
        },
        trendClass(value, inverse = false) {
            const n = Number(value || 0);
            if (n === 0) return 'text-slate-400';
            const positiveGood = inverse ? n < 0 : n > 0;
            return positiveGood ? 'text-emerald-500' : 'text-rose-500';
        },
        formatQuotaCategory(category) {
            const map = {
                daily_token: 'Daily token',
                monthly_token: 'Monthly token',
                daily_cost: 'Daily cost',
                monthly_cost: 'Monthly cost',
                formula: 'Formula',
                quota: 'Quota'
            };
            return map[category] || category;
        },
        exportCsv(filename, rows) {
            const data = Array.isArray(rows) ? rows : [];
            if (!data.length) return;
            const keys = [...new Set(data.flatMap(row => Object.keys(row || {})))];
            const escape = (v) => {
                const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
                return '"' + s.replaceAll('"', '""') + '"';
            };
            const csv = [keys.join(','), ...data.map(row => keys.map(k => escape(row[k])).join(','))].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        }
    };
};
