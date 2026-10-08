
document.addEventListener('_ch_scroll_down', (e) => {
  const { iterations, px, ms } = e.detail;
  const scroller = document.querySelector('.layout-container-desktop');
  if (!scroller) {
    document.dispatchEvent(new CustomEvent('_ch_scroll_done', { detail: { finalY: 0, scroller: 'NOT_FOUND' } }));
    return;
  }
  if (!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
    scroller.style.overflowY = 'scroll';
  }
  document.dispatchEvent(new CustomEvent('_ch_scroll_found', { detail: { scroller: 'layout-container-desktop' } }));
  let count = 0;
  const t = setInterval(() => {
    scroller.scrollBy({ top: px, behavior: 'smooth' });
    count++;
    if (count >= iterations) {
      clearInterval(t);
      document.dispatchEvent(new CustomEvent('_ch_scroll_done', {
        detail: { finalY: Math.round(scroller.scrollTop), scroller: 'layout-container-desktop' }
      }));
    }
  }, ms);
});

document.addEventListener('_ch_scroll_smart', () => {
  const scroller = document.querySelector('.layout-container-desktop');
  if (!scroller) {
    document.dispatchEvent(new CustomEvent('_ch_scroll_smart_done', { detail: { finalY: 0, reason: 'NOT_FOUND' } }));
    return;
  }
  if (!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
    scroller.style.overflowY = 'scroll';
  }

  document.dispatchEvent(new CustomEvent('_ch_scroll_found', { detail: { scroller: 'layout-container-desktop (smart)' } }));

  const PX = 400;   
  const MS = 120;   
  const MAX = 200;  


  let count = 0;
  let stallCount = 0;
  let lastScrollTop = -1;

  const t = setInterval(() => {
    scroller.scrollTop += PX;
    count++;

    const currentTop = Math.round(scroller.scrollTop);
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 50;

    if (currentTop === Math.round(lastScrollTop)) {
      stallCount++;
    } else {
      stallCount = 0;
    }
    lastScrollTop = currentTop;

    const stalled = stallCount >= 4;

    if (atBottom || stalled || count >= MAX) {
      clearInterval(t);
      const reason = atBottom ? 'bottom' : stalled ? 'stalled' : 'max_steps';
      setTimeout(() => {
        document.dispatchEvent(new CustomEvent('_ch_scroll_smart_done', {
          detail: { finalY: Math.round(scroller.scrollTop), reason, steps: count }
        }));
      }, 400);
    }
  }, MS);
});

document.addEventListener('_ch_scroll_to', (e) => {
  const scroller = document.querySelector('.layout-container-desktop');
  if (scroller) scroller.scrollBy({ top: e.detail.y, behavior: 'smooth' });
});
