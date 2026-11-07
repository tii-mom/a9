import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appLink, parseCommand, sanitizeStartPayload, squadInviteLink, verifyWebhookSecret } from './commands';

test('parseCommand: 普通命令与参数', () => {
  assert.deepEqual(parseCommand('/start r_ABC_s_XYZ'), { name: 'start', args: 'r_ABC_s_XYZ' });
  assert.deepEqual(parseCommand('  /gate  '), { name: 'gate', args: '' });
  assert.deepEqual(parseCommand('/RANK'), { name: 'rank', args: '' });
});

test('parseCommand: 群里 @机器人 后缀', () => {
  assert.deepEqual(parseCommand('/team@A9Bot', 'a9bot'), { name: 'team', args: '' });
  assert.equal(parseCommand('/team@OtherBot', 'A9Bot'), null);
  assert.deepEqual(parseCommand('/team@OtherBot'), { name: 'team', args: '' });
});

test('parseCommand: 非命令与空输入返回 null', () => {
  assert.equal(parseCommand('hello /gate'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand(undefined), null);
  assert.equal(parseCommand('/'), null);
  assert.equal(parseCommand('/@A9Bot'), null);
});

test('sanitizeStartPayload: 只保留安全字符集', () => {
  assert.equal(sanitizeStartPayload('s_ABC123'), 's_ABC123');
  assert.equal(sanitizeStartPayload('r_x-y more words'), 'r_x-y');
  assert.equal(sanitizeStartPayload('bad&evil=1'), undefined);
  assert.equal(sanitizeStartPayload('a'.repeat(65)), undefined);
  assert.equal(sanitizeStartPayload(''), undefined);
  assert.equal(sanitizeStartPayload(undefined), undefined);
});

test('verifyWebhookSecret: 必须与配置完全一致，未配置则拒绝', () => {
  assert.equal(verifyWebhookSecret('s3cret', 's3cret'), true);
  assert.equal(verifyWebhookSecret('s3creT', 's3cret'), false);
  assert.equal(verifyWebhookSecret('s3cret-long', 's3cret'), false);
  assert.equal(verifyWebhookSecret(null, 's3cret'), false);
  assert.equal(verifyWebhookSecret('', ''), false);
  assert.equal(verifyWebhookSecret('anything', undefined), false);
});

test('链接拼装：小程序与战队邀请 startapp=s_<code>', () => {
  assert.equal(appLink('A9Bot'), 'https://t.me/A9Bot/app');
  assert.equal(appLink('A9Bot', 's_K7P2QX'), 'https://t.me/A9Bot/app?startapp=s_K7P2QX');
  assert.equal(squadInviteLink('A9Bot', 'K7P2QX'), 'https://t.me/A9Bot/app?startapp=s_K7P2QX');
});
