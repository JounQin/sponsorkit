import type { Provider, Sponsorship } from '../types.ts'
import { $fetch } from 'ofetch'

export const PatreonProvider: Provider = {
  name: 'patreon',
  fetchSponsors(config) {
    if (config.mode === 'sponsees') {
      console.warn('[sponsorkit] Patreon provider does not support `mode: "sponsees"` yet')
      return Promise.resolve([])
    }

    return fetchPatreonSponsors(config.patreon?.token || config.token!)
  },
}

/** Patreon's v2 API base. The v1 API was retired on 2026-10-07. */
const PATREON_API = 'https://www.patreon.com/api/oauth2/v2'
const USER_AGENT = 'SponsorKit (https://github.com/antfu-collective/sponsorkit)'

/**
 * A JSON:API resource. Every resource carries the relationship ids needed to join members to the
 * users and tiers in `included`, so any page can serve them all.
 */
interface PatreonResource<A = unknown> {
  id?: string
  type?: string
  attributes?: A
  /** JSON:API spells to-one relationships as an object and to-many as an array. */
  relationships?: Record<string, { data?: { id?: string, type?: string } | { id?: string, type?: string }[] | null }>
}

/** `patron_status` is null for members who never pledged; the other two mark past sponsors. */
type PatronStatus = 'active_patron' | 'former_patron' | 'declined_patron'

export interface PatreonMemberAttributes {
  currently_entitled_amount_cents?: number | null
  patron_status?: PatronStatus | null
  pledge_relationship_start?: string | null
  lifetime_support_cents?: number | null
}

/** Patreon sends `null` for these when a member has opted out of sharing their profile. */
export interface PatreonUserAttributes {
  first_name?: string | null
  full_name?: string | null
  image_url?: string | null
  url?: string | null
}

interface PatreonTierAttributes {
  amount_cents?: number | null
}

/** Discriminated on `type`, so a `find` narrows to the resource it matched. */
interface PatreonUserResource extends PatreonResource<PatreonUserAttributes> {
  type: 'user'
}

interface PatreonTierResource extends PatreonResource<PatreonTierAttributes> {
  type: 'tier'
}

type PatreonIncludedResource = PatreonUserResource | PatreonTierResource

interface PatreonCampaignData {
  data?: PatreonResource[]
  links?: { next?: string }
}

interface PatreonMembersData {
  data?: PatreonResource<PatreonMemberAttributes>[]
  included?: PatreonIncludedResource[]
  links?: { next?: string }
}

/** A member joined to the user and tier it references in `included`. */
interface PatreonSponsorRecord {
  membership: PatreonResource<PatreonMemberAttributes>
  patron: PatreonUserResource | undefined
  tier: PatreonTierResource | undefined
}

export async function fetchPatreonSponsors(token: string): Promise<Sponsorship[]> {
  if (!token)
    throw new Error('Patreon token is required')

  const campaignId = await fetchPatreonCampaignId(token)

  // API v2 returns up to 1000 members per page and paginates with a `links.next` cursor.
  const sponsors: PatreonSponsorRecord[] = []
  let sponsorshipApi: string | undefined = `${PATREON_API}/campaigns/${campaignId}/members?include=user,currently_entitled_tiers&fields%5Bmember%5D=currently_entitled_amount_cents,patron_status,pledge_relationship_start,lifetime_support_cents&fields%5Buser%5D=image_url,url,first_name,full_name&fields%5Btier%5D=amount_cents`

  do {
    // The annotation is not redundant: this pagination loop feeds `links.next` back into
    // `sponsorshipApi`, so TypeScript cannot resolve the type argument on its own and reports
    // TS7022 (circular inference) without it.
    const sponsorshipData: PatreonMembersData = await $fetch<PatreonMembersData>(sponsorshipApi, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      responseType: 'json',
    })
    const included = Array.isArray(sponsorshipData?.included) ? sponsorshipData.included : []
    const members = Array.isArray(sponsorshipData?.data) ? sponsorshipData.data : []
    // Split once so the lookups below are typed by resource rather than by a union.
    const users = included.filter((v): v is PatreonUserResource => v.type === 'user')
    const tiers = included.filter((v): v is PatreonTierResource => v.type === 'tier')

    sponsors.push(
      ...members
        // Filter out "never pledged" members
        .filter(membership => membership.attributes?.patron_status != null)
        .map(membership => ({
          membership,
          patron: users.find(v => v.id === relatedId(membership, 'user', 0)),
          tier: tiers.find(v => v.id === relatedId(membership, 'currently_entitled_tiers', 0)),
        })),
    )
    sponsorshipApi = sponsorshipData?.links?.next
  } while (sponsorshipApi)

  return sponsors.map((raw): Sponsorship => {
    const attributes = raw.membership.attributes
    // Patreon masks the identity of members who opted out of sharing their profile.
    const patronAttributes = raw.patron?.attributes
    const name = patronAttributes?.full_name || patronAttributes?.first_name || 'Anonymous'

    // A gifted membership can have no entitled amount but still name a paid tier.
    const entitledCents = attributes?.currently_entitled_amount_cents
    const tierCents = raw.tier?.attributes?.amount_cents
    const monthlyDollars = entitledCents == null || entitledCents <= 0
      ? Math.floor((tierCents ?? 0) / 100)
      : Math.floor(entitledCents / 100)

    const sponsor: Sponsorship = {
      sponsor: {
        avatarUrl: patronAttributes?.image_url || '',
        login: patronAttributes?.first_name || name,
        name,
        type: 'User', // Patreon only support user
        linkUrl: patronAttributes?.url ?? undefined,
      },
      isOneTime: false, // One-time pledges not supported
      monthlyDollars,
      privacyLevel: 'PUBLIC', // Patreon is all public
      tierName: 'Patreon',
      createdAt: attributes?.pledge_relationship_start ?? undefined,
    }

    // The "former_patron" and "declined_patron" both is past sponsors
    if (['former_patron', 'declined_patron'].includes(attributes?.patron_status ?? ''))
      sponsor.monthlyDollars = -1

    return sponsor
  })
}

/**
 * Resolve the campaign owned by the authenticated user.
 */
async function fetchPatreonCampaignId(token: string): Promise<string> {
  const userData = await $fetch<PatreonCampaignData>(`${PATREON_API}/campaigns`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    responseType: 'json',
  })
  const campaignId = userData?.data?.[0]?.id
  if (!campaignId) {
    throw new Error(
      'No Patreon campaign found for the given token. '
      + 'Make sure the token belongs to a creator account and was created for a v2 client '
      + '(the v2 `campaigns` scope is required).',
    )
  }
  return campaignId
}

/** Read the id at `index` from a JSON:API relationship that may be a to-one or to-many. */
function relatedId(resource: PatreonResource, name: string, index: number): string | undefined {
  const data = resource.relationships?.[name]?.data
  const entry = Array.isArray(data) ? data[index] : data
  return entry?.id
}
