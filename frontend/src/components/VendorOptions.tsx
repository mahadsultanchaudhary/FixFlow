import { useEffect, useState } from 'react';
import type { AppointmentOption, Vendor } from '../lib/types';

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function estimatedTotal(repairCost: number | undefined, visitFee: number | undefined, explicitTotal?: number): number | undefined {
  if (typeof explicitTotal === 'number') return explicitTotal;
  if (typeof repairCost === 'number') return repairCost + (visitFee ?? 0);
  return undefined;
}

function eligibility(totalCost: number | undefined, brandAuthorized: number | boolean | undefined, budget: number, requireBrandAuthorized: boolean): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (typeof totalCost === 'number' && totalCost > budget) reasons.push(`Over budget by ${money(totalCost - budget)}`);
  if (requireBrandAuthorized && !Boolean(brandAuthorized)) reasons.push('Not marked brand-authorized');
  return { eligible: reasons.length === 0, reasons };
}

function BudgetControls({ budget, setBudget, requireBrandAuthorized, setRequireBrandAuthorized }: {
  budget: number;
  setBudget: (budget: number) => void;
  requireBrandAuthorized: boolean;
  setRequireBrandAuthorized: (value: boolean) => void;
}) {
  const [budgetDraft, setBudgetDraft] = useState(String(budget));
  useEffect(() => setBudgetDraft(String(budget)), [budget]);

  function commitBudgetDraft() {
    const parsed = Number(budgetDraft);
    if (!budgetDraft.trim() || !Number.isFinite(parsed)) {
      setBudgetDraft(String(budget));
      return;
    }
    setBudget(Math.min(1000, Math.max(50, Math.round(parsed))));
  }

  return (
    <div className="vendor-filter-controls" aria-label="Repair partner price and authorization filters">
      <div className="budget-head">
        <label htmlFor="repair-budget-range">Price range · maximum all-in budget</label>
        <div className="budget-entry"><span>$</span><input aria-label="Repair budget amount" type="number" min={50} max={1000} step={25} value={budgetDraft} onChange={(event) => setBudgetDraft(event.target.value)} onBlur={commitBudgetDraft} onKeyDown={(event) => { if (event.key === 'Enter') { commitBudgetDraft(); (event.currentTarget as HTMLInputElement).blur(); } }} /></div>
      </div>
      <input id="repair-budget-range" aria-label="Repair budget slider" className="budget-slider" type="range" min={50} max={1000} step={25} value={budget} onChange={(event) => setBudget(Number(event.target.value))} />
      <div className="budget-scale"><span>$50 · lower</span><span>$1,000 · higher</span></div>
      <div className="budget-summary" aria-live="polite">Showing repair partners against a <strong>{money(budget)}</strong> all-in cap, including the repair estimate and visit fee.</div>
      <label className="authorization-toggle"><input type="checkbox" checked={requireBrandAuthorized} onChange={(event) => setRequireBrandAuthorized(event.target.checked)} /><span className="toggle-mark">✓</span><span><strong>Official brand-authorized only</strong><small>Turn off to include lower-cost options without simulated authorization. This is not a live manufacturer directory.</small></span></label>
    </div>
  );
}

export function VendorComparison({ vendors, onRefresh, onSelectVendor, disabled = false, activeBooking = false, bookedVendorId, budget = 250, setBudget = () => {}, requireBrandAuthorized = true, setRequireBrandAuthorized = () => {} }: {
  vendors: Vendor[];
  onRefresh?: () => void;
  onSelectVendor?: (vendor: Vendor) => void;
  disabled?: boolean;
  activeBooking?: boolean;
  bookedVendorId?: string | null;
  budget?: number;
  setBudget?: (budget: number) => void;
  requireBrandAuthorized?: boolean;
  setRequireBrandAuthorized?: (value: boolean) => void;
}) {
  if (!vendors.length) return null;
  const evaluations = vendors.map((vendor) => ({ vendor, total: estimatedTotal(vendor.estimated_repair_cost, vendor.estimated_visit_fee, vendor.estimated_total_cost), match: eligibility(estimatedTotal(vendor.estimated_repair_cost, vendor.estimated_visit_fee, vendor.estimated_total_cost), vendor.brand_authorized, budget, requireBrandAuthorized) }));
  const recommended = evaluations.find(({ vendor, match }) => match.eligible && Boolean(vendor.is_preferred)) || evaluations.find(({ match }) => match.eligible);
  return (
    <section className="surface-card vendor-comparison">
      <div className="section-heading">
        <div><span className="eyebrow">SIMULATED REPAIR PARTNERS</span><h3>Find a fit for your home.</h3></div>
        {onRefresh && <button className="text-button" onClick={onRefresh} type="button" disabled={disabled}>Refresh estimates ↗</button>}
      </div>
      <BudgetControls budget={budget} setBudget={setBudget} requireBrandAuthorized={requireBrandAuthorized} setRequireBrandAuthorized={setRequireBrandAuthorized} />
      <div className="vendor-match-list">
        {evaluations.map(({ vendor, total, match }, index) => {
          const isRecommended = recommended?.vendor.id === vendor.id;
          const brandOkay = Boolean(vendor.brand_authorized);
          const isBookedPartner = activeBooking && vendor.id === bookedVendorId;
          return (
            <article className={`vendor-match-card ${match.eligible ? 'vendor-match-eligible' : 'vendor-match-excluded'}`} key={vendor.id}>
              <div className={`vendor-avatar vendor-avatar-${index % 3}`}>{vendor.name.slice(0, 1)}</div>
              <div className="vendor-match-main">
                <div className="vendor-name-line"><strong>{vendor.name}</strong>{isRecommended && <span className="preferred-tag">Recommended</span>}</div>
                <div className="vendor-credentials"><span className={brandOkay ? 'credential-good' : 'credential-warning'}>{brandOkay ? '✓ Brand-authorized (simulated)' : '! Not brand-authorized'}</span><span>{vendor.reliability_score}% reliability · {vendor.previous_household_jobs} prior household jobs</span></div>
                {!match.eligible && <div className="vendor-exclusion">{match.reasons.join(' · ')}</div>}
                {match.eligible && !isRecommended && <div className="vendor-eligible-note">Fits your current preferences</div>}
                <div className="vendor-select-row">
                  {isBookedPartner
                    ? <span className="booked-partner-badge">Current Booked Partner</span>
                    : <button
                        className={`button ${match.eligible ? 'button-primary' : 'button-quiet'} vendor-select-button`}
                        type="button"
                        disabled={disabled || activeBooking || !match.eligible || !onSelectVendor}
                        onClick={() => onSelectVendor?.(vendor)}
                        aria-label={`Select ${vendor.name} as repair partner`}
                      >
                        {activeBooking ? 'Visit already scheduled' : match.eligible ? 'Select repair partner & view times' : 'Excluded by filters'}
                      </button>}
                  {match.eligible && !activeBooking && <small>Choose a time next. Nothing is booked until you approve.</small>}
                </div>
              </div>
              <div className="vendor-match-price"><strong>{total === undefined ? 'Estimate unavailable' : money(total)}</strong><small>estimated all-in total</small><span>{money(vendor.estimated_repair_cost)} repair + {money(vendor.estimated_visit_fee)} visit fee</span></div>
            </article>
          );
        })}
      </div>
      <p className="simulation-note">All prices, reliability scores and authorization statuses are seeded demo values, not quotes or real certification checks.</p>
    </section>
  );
}

function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-PK', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export function AlternativeOptions({ options, onChoose, disabled, budget = 250, requireBrandAuthorized = true, selectedVendorName }: {
  options: AppointmentOption[];
  onChoose: (option: AppointmentOption) => void;
  disabled: boolean;
  budget?: number;
  requireBrandAuthorized?: boolean;
  selectedVendorName?: string | null;
}) {
  const isVendorSelection = Boolean(selectedVendorName);
  return (
    <section className="surface-card alternatives-card">
      <div className="section-heading"><div><span className="eyebrow">{isVendorSelection ? 'REPAIR PARTNER SELECTED' : 'NO-SHOW RECOVERY'}</span><h3>{isVendorSelection ? `Choose a time with ${selectedVendorName}` : 'Let’s find a better time.'}</h3></div><span className="demo-tag">SIMULATED</span></div>
      <p className="muted-copy">{isVendorSelection
        ? 'Choose a calendar-compatible time with this repair partner. This creates a proposal only. Your existing appointment stays booked until you approve a replacement.'
        : 'Choose an option that fits the calendar, your budget, and your authorization preference. An option is not booked until the exact proposal is approved.'}</p>
      {!options.length ? <div className="empty-state">No conflict-free slots are available for this selection. Try another repair partner or refresh the estimates.</div> : (
        <div className="alternative-list">
          {options.map((option) => {
            const slotKey = option.slot_id || option.id || `${option.vendor_id}-${option.starts_at}`;
            const total = estimatedTotal(option.estimated_repair_cost, option.estimated_visit_fee ?? option.price_estimate, option.estimated_total_cost);
            const match = eligibility(total, option.brand_authorized, budget, requireBrandAuthorized);
            const reasons = match.reasons;
            const allowed = match.eligible;
            return (
              <article className={`alternative-option ${allowed ? '' : 'alternative-option-excluded'}`} key={slotKey}>
                <div className="alternative-date"><span>{dateTime(option.starts_at).split(',')[0]}</span><b>{dateTime(option.starts_at).split(',').slice(1).join(',')}</b></div>
                <div className="alternative-vendor"><strong>{option.vendor_name}</strong><span>{option.reliability_score}% reliability · {option.previous_household_jobs} prior household {option.previous_household_jobs === 1 ? 'job' : 'jobs'}</span><span>{total === undefined ? 'Estimate unavailable' : `${money(total)} estimated all-in total`}</span>{Boolean(option.brand_authorized) ? <span className="credential-good">✓ Brand-authorized (simulated)</span> : <span className="credential-warning">! Not brand-authorized</span>}{Boolean(option.is_preferred) && <span className="preferred-inline">★ Household preferred</span>}{!allowed && <span className="vendor-exclusion">{reasons.join(' · ') || 'Outside selected preferences'}</span>}</div>
                <div className="alternative-price"><strong>{total === undefined ? 'Estimate unavailable' : money(total)}</strong><span>estimated total</span><small>{typeof option.estimated_repair_cost === 'number' ? `${money(option.estimated_repair_cost)} repair + ${money(option.estimated_visit_fee ?? option.price_estimate)} visit` : 'Breakdown unavailable'}</small></div>
                <button className={`button ${allowed ? 'button-outline' : 'button-quiet'} option-choose`} disabled={disabled || !allowed} onClick={() => onChoose(option)} type="button">{allowed ? 'Choose time' : 'Excluded'}</button>
              </article>
            );
          })}
        </div>
      )}
      <p className="simulation-note">Estimates and authorization are simulated household demo records.</p>
    </section>
  );
}
