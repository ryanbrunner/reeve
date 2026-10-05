import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EXIT } from '../exit.js';
import { engineFloor, exitFor, gitCheck, nodeCheck, satisfiesEngine, verdict } from './doctor.js';

describe('satisfiesEngine', () => {
  test('>=22.12 against the versions either side of it', () => {
    assert.equal(satisfiesEngine('22.11.0', '>=22.12'), false);
    assert.equal(satisfiesEngine('22.12.0', '>=22.12'), true);
    assert.equal(satisfiesEngine('22.17.0', '>=22.12'), true);
    assert.equal(satisfiesEngine('23.0.0', '>=22.12'), true);
    assert.equal(satisfiesEngine('20.19.1', '>=22.12'), false);
  });

  test('a patch floor, and a leading v on either side', () => {
    assert.equal(satisfiesEngine('v22.12.0', '>=v22.12.1'), false);
    assert.equal(satisfiesEngine('22.12.1', '>= 22.12.1'), true);
  });

  test('a range it cannot read is unanswered, not guessed', () => {
    assert.equal(engineFloor('^22.12 || >=24'), null);
    assert.equal(satisfiesEngine('22.17.0', '^22.12'), null);
  });
});

describe('nodeCheck', () => {
  test('an old Node fails and says what to install', () => {
    const c = nodeCheck('22.11.0', '>=22.12');
    assert.equal(c.status, 'fail');
    assert.match(c.fix ?? '', /Node 22\.12\.0 or newer/);
  });

  test('an unreadable range warns rather than failing the install', () => {
    assert.equal(nodeCheck('22.17.0', '^22.12').status, 'warn');
  });
});

describe('exitFor', () => {
  const ok = verdict('node', 'required', true, 'v22.17.0', 'install Node');
  const info = verdict('server', 'info', false, 'none answers', 'start it with `reeve serve`');

  test('a failed optional check still exits 0', () => {
    const gh = verdict('gh', 'optional', false, 'not installed', 'install gh');
    assert.equal(gh.status, 'warn');
    assert.equal(exitFor([ok, gh, info]), EXIT.ok);
  });

  test('a failed required check exits 1', () => {
    const git = verdict('git', 'required', false, 'not on PATH', 'install git');
    assert.equal(git.status, 'fail');
    assert.equal(exitFor([ok, git, info]), EXIT.error);
  });

  test('a passed check drops its fix, and an informational one keeps it', () => {
    assert.equal(ok.fix, null);
    assert.equal(info.status, 'info');
    assert.equal(info.fix, 'start it with `reeve serve`');
  });
});

describe('gitCheck', () => {
  test('with git off PATH, it fails and says how to install it', async () => {
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      const c = await gitCheck();
      assert.equal(c.status, 'fail');
      assert.equal(c.detail, 'not on PATH');
      assert.match(c.fix ?? '', /install git/);
    } finally {
      process.env.PATH = path;
    }
  });
});
