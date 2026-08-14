# Contributing

Thanks for your interest in contributing to moneta-notes.

## Signed commits

All commits to `main` must be cryptographically signed (GPG or SSH) — GitHub
enforces this on the branch and will reject unsigned pushes/merges. Set up
commit signing per
[GitHub's guide](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits),
then enable it for this repo (or globally):

```
git config commit.gpgsign true
```

This is separate from, and in addition to, the DCO sign-off below — a
cryptographic signature verifies *who* made the commit, while the DCO
sign-off certifies *the right to submit it*.

## Developer Certificate of Origin

This project requires that all contributions be certified under the
[Developer Certificate of Origin](https://developercertificate.org/) (DCO). The
DCO is a lightweight attestation that you wrote the contribution, or otherwise
have the right to submit it under the project's license — it does not require
signing a separate agreement or assigning copyright.

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
1 Letterman Drive
Suite D4700
San Francisco, CA, 94129

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

### Signing off commits

Certify each commit by adding a `Signed-off-by` trailer with your real name
and email:

```
git commit -s
```

This appends a line like:

```
Signed-off-by: Jane Doe <jane@example.com>
```

If you forgot to sign off:

```
# most recent commit
git commit --amend -s

# multiple commits (last N on the branch)
git rebase --signoff HEAD~N
```

Pull requests are checked automatically in CI, and PRs with unsigned commits
will be blocked from merging.
