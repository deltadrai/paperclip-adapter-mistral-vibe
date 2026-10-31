// reveals.js — GSAP entrance and scroll-reveal animations.
// Consumes gsap + ScrollTrigger injected via ctx from main.js.

export function createReveals({ gsap, ScrollTrigger }) {
  return {
    init() {
      const mm = gsap.matchMedia();

      mm.add(
        {
          reduced: '(prefers-reduced-motion: reduce)',
          animated: '(prefers-reduced-motion: no-preference)',
        },
        (context) => {
          const { reduced } = context.conditions;

          if (reduced) {
            gsap.set('[data-reveal], [data-hero]', { clearProps: 'all' });
            return;
          }

          // Hero entrance: eyebrow -> headline -> subline -> CTAs -> badges
          gsap.from('[data-hero]', {
            autoAlpha: 0,
            y: 24,
            duration: 0.7,
            ease: 'power3.out',
            stagger: 0.12,
          });

          // Feature cards: one ScrollTrigger on the grid, staggered
          const cards = gsap.utils.toArray('#features .card-hard');
          gsap.from(cards, {
            scrollTrigger: {
              trigger: '#features .grid',
              start: 'top 85%',
              once: true,
            },
            autoAlpha: 0,
            y: 28,
            duration: 0.6,
            ease: 'power2.out',
            stagger: 0.08,
          });

          // All other reveal elements: individual ScrollTriggers
          gsap.utils.toArray('[data-reveal]')
            .filter((el) => !cards.includes(el))
            .forEach((el) => {
              gsap.from(el, {
                scrollTrigger: {
                  trigger: el,
                  start: 'top 85%',
                  once: true,
                },
                autoAlpha: 0,
                y: 28,
                duration: 0.6,
                ease: 'power2.out',
              });
            });
        },
      );
    },
  };
}
