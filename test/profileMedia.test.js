import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featuredMedia } from '../src/utils/messages.js';

/**
 * A family deciding whether to let somebody into their home with their
 * children should see that person's face. It used to be the one thing the
 * profile left out.
 */

test('her headshot is sent, and sent first', () => {
  const media = featuredMedia({
    profilePictures: [{ url: '/media/face.jpg', approved: true, featured: true }],
    videos: [{ url: '/media/intro.mp4', approved: true, featured: true }],
    photos: [{ url: '/media/work.jpg', approved: true, featured: true }],
  });

  assert.equal(media.length, 3, 'headshot, video and work photo all go');
  assert.equal(media[0].url, '/media/face.jpg', 'her face leads the profile');
  assert.equal(media[0].kind, 'photo');
});

test('a profile picture that was never featured still gets sent', () => {
  // Profiles approved before the featured flag existed carry only the
  // resolved URL. Without the fallback they showed no picture at all.
  const media = featuredMedia({ profilePhotoUrl: '/media/her.jpg' });

  assert.equal(media.length, 1);
  assert.equal(media[0].url, '/media/her.jpg');
});

test('an unapproved picture is never shown to a family', () => {
  // Approval is the gate. A picture waiting for review must not reach anyone.
  const media = featuredMedia({
    profilePictures: [{ url: '/media/pending.jpg', approved: false, featured: true }],
  });

  assert.equal(media.length, 0);
});

test('only one headshot goes, however many are featured', () => {
  const media = featuredMedia({
    profilePictures: [
      { url: '/media/a.jpg', approved: true, featured: true },
      { url: '/media/b.jpg', approved: true, featured: true },
      { url: '/media/c.jpg', approved: true, featured: true },
    ],
  });

  assert.equal(media.length, 1, 'a profile has one face');
  assert.equal(media[0].url, '/media/a.jpg');
});

test('a nanny with no pictures sends nothing rather than a broken link', () => {
  assert.equal(featuredMedia({}).length, 0);
  assert.equal(featuredMedia({ videos: [], photos: [], profilePictures: [] }).length, 0);
});
