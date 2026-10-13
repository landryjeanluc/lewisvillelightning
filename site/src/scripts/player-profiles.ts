import { api } from './api-client';
import { md } from './live';
void (async () => {
  const response = await api('/profiles');
  if (!response.ok) return;
  const profiles = response.body;
  for (const card of document.querySelectorAll<HTMLElement>('[data-player-card]')) {
    const profile = profiles[card.dataset.playerCard!];
    if (!profile?.card_art || card.dataset.allowPhoto !== 'true') continue;
    // The API validates local image paths; also reject unexpected stored values.
    const path = profile.card_art as string;
    if (!/^\/(uploads|photos)\/[^\\?#]+\.(jpg|jpeg|png|webp)$/i.test(path) || path.includes('/../')) continue;
    const image = document.createElement('img');
    image.className = 'pc-photo'; image.src = path; image.alt = 'Player card';
    image.addEventListener('load', () => {
      card.querySelectorAll('picture, .pc-photo, .pc-number, .pc-watermark').forEach(node => node.remove());
      card.classList.add('pcard--art'); card.querySelector('.pc-art')!.append(image);
    }, {once:true});
  }
  for (const section of document.querySelectorAll<HTMLElement>('[data-profile-detail]')) {
    const profile = profiles[section.dataset.profileDetail!];
    if (!profile?.bio) continue;
    section.querySelector('div')!.innerHTML = md(profile.bio);
    section.hidden = false;
  }
})();
