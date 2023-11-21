import * as core from '@actions/core';
import { context } from '@actions/github';
import SemVer from 'semver/classes/semver';
import coerce from 'semver/functions/coerce';
import semverParse from 'semver/functions/parse';
import type { GitHub, GraphQlQueryRepository } from './types';
import { queryAllRefs } from '@actionstagger/util';

namespace Functions.Private {
    /**
     * Checks if the event that triggered this action was a release
     * See: https://docs.github.com/en/webhooks/webhook-events-and-payloads#release
     */
    export function isRelease(): boolean {
        return context.eventName === 'release';
    }

    /**
     * Check if the event that triggered this actions was as a result
     * of a prerelease or not
     *
     * For some reason, it is not enough to check if the action is
     * prereleased, because even prereleases have the action of "published"
     * See: https://github.com/orgs/community/discussions/26281
     * See also: https://docs.github.com/en/webhooks/webhook-events-and-payloads#release
     */
    export function isPreRelease(): boolean {
        return context.payload.release?.prerelease === true;
    }

    /**
     * Is a release available to the public?
     * A pre-release is usually considered "not ready" for public use
     */
    export function isPublicRelease(): boolean {
        return Private.isRelease() && !Private.isPreRelease();
    }

    /**
     * Checks if the event that triggered this action was a push
     * See: https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
     */
    export function isPush(): boolean {
        return context.eventName === 'push';
    }

    /**
     * Check if the push event created a new ref
     */
    export function isNewRefPush(): boolean {
        return Private.isPush() && context.payload.created === true;
    }

    /**
     * @returns true if the event is a branch push
     */
    export function isBranchPush(): boolean {
        return Private.isNewRefPush() && context.payload.ref.startsWith('refs/heads/');
    }

    /**
     * @returns true if the event is a tag push
     */
    export function isTagPush(): boolean {
        return Private.isNewRefPush() && context.payload.ref.startsWith('refs/tags/');
    }

    /**
     * Creates the given ref for this release
     * refName must begin with tags/ or heads/
     *
     * @param github The github client
     * @param refName The name of the ref to use. ex tags/latest, heads/v1, etc
     */
    export async function createRef(github: GitHub, refName: string) {
        const { data: matchingRefs } = await github.rest.git.listMatchingRefs({
            ...context.repo,
            ref: refName,
        });

        const matchingRef = matchingRefs.find((refObj: { ref: string }) => {
            return refObj.ref.endsWith(refName);
        });

        let upstreamRef: unknown;

        if (matchingRef !== undefined) {
            core.info(`Updating ref: ${refName} to: ${process.env.GITHUB_SHA}`);
            ({ data: upstreamRef } = await github.rest.git.updateRef({
                ...context.repo,
                force: true,
                ref: refName,
                sha: process.env.GITHUB_SHA,
            }));
        } else {
            core.info(`Creating ref: refs/${refName} for: ${process.env.GITHUB_SHA}`);
            ({ data: upstreamRef } = await github.rest.git.createRef({
                ...context.repo,
                ref: `refs/${refName}`,
                sha: process.env.GITHUB_SHA,
            }));
        }

        if (core.isDebug()) {
            core.debug(
                `${JSON.stringify(upstreamRef)} now points to: "${
                    process.env.GITHUB_SHA
                }"`
            );
        }
    }

    /**
     * List all the refs in the repository based on user's preferred ref
     *
     * @param github The github client
     * @param preferredRef The user's preferred ref (heads | tags)
     */
    export async function* listAllRefs(github: GitHub, preferredRef: string) {
        for (let nextPage: string; true; ) {
            const { repository }: { repository: GraphQlQueryRepository } =
                await github.graphql(queryAllRefs, {
                    repoName: context.repo.repo,
                    repoOwner: context.repo.owner,
                    majorRef: `refs/${preferredRef}/`,
                    pagination: nextPage,
                });

            for (const { ref } of repository.refs.refsList) {
                const semverRef = semverParse(ref.name);
                if (semverRef !== null) {
                    if (core.isDebug()) {
                        core.debug(`checking ${ref.name}`);
                    }
                    yield [semverRef, ref.object.shaId] as const;
                } else if (core.isDebug()) {
                    core.debug(`ignoring ${ref.name}`);
                }
            }

            if (repository.refs.pageInfo.hasNextPage) {
                nextPage = repository.refs.pageInfo.endCursor;
            } else {
                break;
            }
        }
    }

    /**
     * Get the ref version for the current push
     *
     * @returns the ref for this release (if any)
     */
    export function getPushRefVersion(preferredRef: string): SemVer {
        let refName: string = (context.payload.ref as string)?.replace(
            new RegExp(`^refs/${preferredRef}/`),
            ''
        );
        return semverParse(refName);
    }

    /**
     * Get the actual tag version for this release. It also takes into account
     * whether or not this is a prerelease
     *
     * @returns the tag for this release (if any)
     */
    export function getReleaseTag(): SemVer {
        let tagName: string | SemVer = context.payload.release?.tag_name;
        if (Private.isPreRelease()) {
            tagName = coerce(tagName);
        }
        return semverParse(tagName);
    }
}

export default Functions.Private;