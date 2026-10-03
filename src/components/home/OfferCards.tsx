import React from 'react';
import { ArrowRight, Briefcase } from 'lucide-react';
import { PLANS } from '../../lib/members/plans';
import type { HomeStrings } from './home-i18n';

interface OfferCardsProps {
  strings: HomeStrings['offer'];
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Membership teaser (prices come from the plan catalogue) next to the business consulting entry. */
export const OfferCards: React.FC<OfferCardsProps> = ({ strings }) => (
  <div className="home-offers">
    <section className="home-side-card home-card home-reveal" aria-labelledby="offer-title">
      <p className="home-eyebrow">{strings.eyebrow}</p>
      <h2 id="offer-title" className="mt-1">{strings.title}</h2>
      <ul className="home-plans">
        {PLANS.map(plan => (
          <li key={plan.id} className="home-plan" data-lift>
            <strong>{strings.plans[plan.id]}</strong>
            <span className="home-price">{usd(plan.price_usd_cents)}<small>{strings.perMonth}</small></span>
            <span>{strings.planNotes[plan.id]}</span>
          </li>
        ))}
      </ul>
      <a href="/pricing" className="home-cta" data-press>
        {strings.cta}<ArrowRight aria-hidden="true" className="w-4 h-4" />
      </a>
    </section>

    <section className="home-side-card home-card home-business home-reveal" aria-labelledby="business-title">
      <p className="home-eyebrow flex items-center gap-1.5"><Briefcase aria-hidden="true" className="w-3.5 h-3.5" />{strings.businessEyebrow}</p>
      <h2 id="business-title" className="mt-1">{strings.businessTitle}</h2>
      <p className="home-credit">{strings.businessBody}</p>
      <a href="/business" className="home-cta" data-press>
        {strings.businessCta}<ArrowRight aria-hidden="true" className="w-4 h-4" />
      </a>
    </section>
  </div>
);
