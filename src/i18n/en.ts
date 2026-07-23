/**
 * English (en) — the source locale and fallback. Paragraphs are authored as flowing
 * prose (no manual line breaks); the About screen wraps them to fit at draw time.
 */
import type {Strings} from './types';

export const en: Strings = {
  aboutTitle: 'ATOMIC CANNON',
  aboutSubtitle: 'A web preservation port',
  repoLabel: 'Source on GitHub',
  back: 'Back',
  about: [
    {
      heading: 'The Story',
      body: [
        'The United Nations banned all atomic and nuclear devices and ordered their destruction. Most were destroyed systematically over a period of years, the only remaining nuclear capable devices were in museums and scattered in hidden secret bunkers around the world.',
        'After global chaos erupted in a heated debate centered on a rogue dictator, the powers that be were battling in small inhospitable environments where only machines could go. As the start of the new world order unfolded, powers needed the most destructive machines they could find to use in battle, aircraft and ground soldiers could not be used because of the harsh weather and terrain.',
        'Thus began the resurrection of the Atomic Cannons. They were outfitted with as many kinds of ammunition systems as possible to deter the enemy. It is your mission to command our Atomic Cannon and be victorious...',
      ],
    },
    {
      heading: 'About the Game',
      body: [
        'Atomic Cannon is a turn-based artillery duel. Two or more cannons take turns lobbing shells across destructible terrain, dialing in angle and power while wind and gravity conspire against a clean hit. Land a shot and the ground caves in around it; miss, and you have handed your rival the range.',
        'Between shots you spend your credits in the weapons depot, stocking everything from humble shells to earth-shattering nuclear ordnance, then reshape the battlefield to bury the opposition. Play solo against the computer or pass-and-play with friends, and be the last cannon standing.',
      ],
    },
    {
      heading: 'About the Real Atomic Cannon',
      body: [
        'The game Atomic Cannon is loosely based on the real life nuclear capable mobile artillery cannon manufactured by the United States. The atomic cannon has a 280mm (11 inch) diameter barrel and can fire atomic projectiles over 20 miles. Twenty cannons were manufactured but none were used in battle.',
        'Operation Upshot Knothole was the only test shot (named Grable) for the atomic cannon, this is the intro screen image. It was on May 25th, 1953 at the Nevada Test Site. The shot traveled 7 miles and yielded 15kt of explosive power with a blast height of 524ft.',
        'The largest atomic cannon sits in a public park in Junction City, Kansas. The atomic cannon (M65-280mm) is 42 feet long and weighs 42,500 lbs.',
      ],
    },
    {
      heading: 'Original Credits',
      body: [
        'Engine, design, programming, artwork, sound, and testing by James Bryant.',
        'Copyright 2003 - 2006 Isotope 244 Graphics LLC.',
      ],
      bullets: [
        'Thanks to the U.S. Department of Energy for their atomic cannon images.',
        'Some images were taken from film footage from the U.S. DOE Nevada Site Office Coordination and Information Center.',
      ],
    },
    {
      heading: 'About This Port',
      body: [
        'This browser edition is a faithful, non-commercial reimplementation of the classic, rebuilt from the ground up in TypeScript so the game keeps running on modern hardware while it looks and plays the way it always did.',
        'Created by Pablo Pizarro R. (ppizarror), a software engineer and long-time fan of the original who built this port to keep the game alive for the web. It is a fan preservation project, not affiliated with or endorsed by Isotope 244 Graphics LLC; all original trademarks and copyrights belong to their respective owners.',
      ],
      bullets: ['Source code and issues: github.com/ppizarror/Atomic-Cannon'],
    },
  ],
};
