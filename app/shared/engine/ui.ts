/** Shared look for the engine pages (addendum 3 §3): one palette, one type scale, quiet by default. */
export const ENGINE_CSS = `
.eg{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;font-size:13.5px;line-height:1.45}
.eg a{color:#5A27E0;text-decoration:none}
.eg-h1{font-size:20px;font-weight:800;margin:0}
.eg-sub{color:#64748b;font-size:12.5px;margin:2px 0 0}
.eg-top{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.eg-chip{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;border-radius:999px;padding:3px 9px;background:#f1f5f9;color:#475569;white-space:nowrap}
.eg-chip.stage{background:#0f172a;color:#fff}
.eg-chip.pending{background:#fef3c7;color:#92400e}
.eg-chip.pending.hot{background:#f59e0b;color:#fff}
.eg-chip.ok{background:#dcfce7;color:#14532d}
.eg-chip.bad{background:#fee2e2;color:#7f1d1d}
.eg-chip.info{background:#e0e7ff;color:#3730a3}
.eg-chip.muted{background:#f1f5f9;color:#94a3b8}
.eg-chip.shadow{background:#312e81;color:#fff}
.eg-btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;font-family:inherit;color:#0f172a}
.eg-btn.primary{background:#0f172a;color:#fff;border-color:#0f172a}
.eg-btn.accent{background:#5A27E0;color:#fff;border-color:#5A27E0}
.eg-btn.danger{background:#fff;color:#b91c1c;border-color:#fecaca}
.eg-btn:disabled{opacity:.45;cursor:not-allowed}
.eg-btn.on{background:#0f172a;color:#fff;border-color:#0f172a}
.eg-sel,.eg-in,.eg-ta{border:1px solid #cbd5e1;border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit;background:#fff;color:#0f172a}
.eg-ta{width:100%;box-sizing:border-box;resize:vertical}
.eg-err{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;font-size:12.5px;margin:8px 0}
.eg-empty{color:#64748b;font-size:14px;padding:30px;text-align:center;border:1px dashed #e2e8f0;border-radius:12px}
.eg-shadow-banner{position:sticky;top:0;z-index:20;background:#312e81;color:#fff;padding:10px 14px;border-radius:10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px;box-shadow:0 2px 8px rgba(49,46,129,.25)}
.eg-shadow-banner b{font-size:11px;letter-spacing:.08em;text-transform:uppercase;background:rgba(255,255,255,.15);padding:3px 8px;border-radius:6px}
.eg-shadow-banner a{color:#c7d2fe;font-weight:600}
.eg-tabs{display:flex;gap:4px;border-bottom:1px solid #e6e8ee;margin:10px 0 14px}
.eg-tab{padding:8px 12px;font-size:13px;font-weight:600;color:#64748b;border:0;background:none;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit}
.eg-tab.on{color:#0f172a;border-bottom-color:#0f172a}
.eg-card{background:#fff;border:1px solid #e6e8ee;border-radius:12px;box-shadow:0 1px 3px rgba(16,24,40,.06)}
.eg-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:12px 0}
.eg-tile{border:1px solid #e6e8ee;border-radius:10px;padding:10px 12px;background:#fff}
.eg-tile b{display:block;font-size:20px;font-weight:800;font-variant-numeric:tabular-nums}
.eg-tile span{font-size:11.5px;color:#64748b}
/* queue */
.q-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:14px;align-items:center;padding:12px 14px;border-bottom:1px solid #f1f5f9;cursor:pointer;text-decoration:none;color:inherit}
.q-row:hover{background:#fafafa}
.q-row:last-child{border-bottom:0}
.q-addr{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.q-ref{color:#94a3b8;font-size:12px}
.q-cell{font-size:12.5px;color:#64748b;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.q-cell b{color:#0f172a}
@media (max-width:640px){.q-row{grid-template-columns:minmax(0,1fr) auto}.q-cell.hide{display:none}}
/* timeline */
.tl{border-left:2px solid #e6e8ee;margin-left:8px;padding-left:16px}
.tl-day{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;margin:18px 0 6px;position:relative}
.tl-day::before{content:'';position:absolute;left:-21px;top:4px;width:8px;height:8px;border-radius:50%;background:#cbd5e1}
.tl-ev{display:flex;gap:10px;align-items:baseline;padding:4px 6px;border-radius:6px;font-size:12.5px;color:#94a3b8;cursor:pointer}
.tl-ev:hover{background:#f8fafc;color:#64748b}
.tl-ev .t{min-width:44px;font-variant-numeric:tabular-nums}
.tl-ev .ty{color:#64748b;font-weight:600}
.tl-ev .ac{font-size:11px}
.tl-ev.sup .ty{color:#6366f1}
.tl-raw{margin:0 0 8px 60px;font-size:11.5px;background:#f8fafc;border:1px solid #e6e8ee;border-radius:8px;padding:8px 10px;white-space:pre-wrap;max-height:260px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155}
.tl-card{display:block;margin:6px 0 10px;padding:12px 14px;border-left:4px solid #f59e0b;text-decoration:none;color:inherit}
.tl-card:hover{box-shadow:0 2px 10px rgba(16,24,40,.08)}
.tl-card.actioned{border-left-color:#16a34a}
.tl-card.escalated{border-left-color:#7c3aed}
.tl-card.bank{border-left-color:#dc2626}
.tl-card.review{border-left-color:#94a3b8}
.tl-card.hidden{opacity:.7;border-style:dashed}
.tl-card-top{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap}
.tl-kind{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#b45309}
.tl-first{font-size:13.5px;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-meta{font-size:11.5px;color:#94a3b8;margin-top:4px}
`;
