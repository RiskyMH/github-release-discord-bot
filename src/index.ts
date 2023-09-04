import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";
import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  type MessageCreateOptions,
} from "discord.js";
import { env } from "./env.js";

class GitHubRelease {
  private readonly name: string;
  private readonly time: Date;
  private readonly url: string;
  private readonly body: string;
  private readonly isPrerelease: boolean;

  private static readonly STABLE_COLOUR = "#0072F7";
  private static readonly PRERELEASE_COLOUR = "#FFB11A";

  public constructor(
    release: RestEndpointMethodTypes["repos"]["listReleases"]["response"]["data"][number],
  ) {
    this.name = release.name ?? "Release name not provided";
    this.time = release.published_at ? new Date(release.published_at) : new Date();
    this.url = release.html_url;
    this.body = release.body ?? "Release body not provided";
    this.isPrerelease = release.prerelease;
  }

  private getFormattedBody(): string {
    return this.body.replace(
      /#(?<number>\d+)/g,
      (_, value) =>
        `[#${value}](<https://github.com/${env.REPO_NAME}/${env.REPO_OWNER}/pulls/${value}>)`,
    );
  }

  public getTime() {
    return this.time;
  }

  public getMessage(): MessageCreateOptions {
    return {
      content: this.isPrerelease
        ? `New Next.js canary release ${this.name}!`
        : `New Next.js release ${this.name}!`,
      embeds: [
        new EmbedBuilder()
          .setTitle(this.name)
          .setURL(this.url)
          .setDescription(this.getFormattedBody())
          .setColor(
            this.isPrerelease ? GitHubRelease.PRERELEASE_COLOUR : GitHubRelease.STABLE_COLOUR,
          ),
      ],
    };
  }
}

class LastUpdatedStore {
  private readonly lastUpdated: Date;
  public constructor() {
    this.lastUpdated = new Date();
  }
  public releaseIsNewer(release: GitHubRelease): boolean {
    return release.getTime() > this.lastUpdated;
  }
  public update(): void {
    this.lastUpdated.setTime(Date.now());
  }
}

class ReleaseChecker {
  private readonly client: Client<true>;
  private readonly octokit = new Octokit({ auth: env.GITHUB_TOKEN });
  private readonly lastUpdatedStore = new LastUpdatedStore();

  options = {
    revalidate: 1000 * 60, // 1 minute
  };

  public constructor(client: Client<true>) {
    this.client = client;
  }

  async getNewReleases(): Promise<GitHubRelease[]> {
    const res = await this.octokit.repos.listReleases({
      owner: env.REPO_OWNER,
      repo: env.REPO_NAME,
    });
    return res.data
      .map(release => new GitHubRelease(release))
      .filter(release => this.lastUpdatedStore.releaseIsNewer(release));
  }

  async postNewRelease(release: GitHubRelease) {
    const releaseChannel = this.client.channels.cache.get(env.RELEASE_CHANNEL_ID);
    if (!releaseChannel || !releaseChannel.isTextBased()) {
      console.error("Release channel is invalid");
      return;
    }
    await releaseChannel.send(release.getMessage());
  }

  async check() {
    const releases = await this.getNewReleases();
    for (const release of releases.sort((a, b) => a.getTime().valueOf() - b.getTime().valueOf())) {
      // eslint-disable-next-line no-await-in-loop -- We want to ensure the order is correct
      await this.postNewRelease(release);
    }
    this.lastUpdatedStore.update();
  }

  public async run() {
    await this.check();
    setInterval(() => void this.check(), this.options.revalidate);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once(Events.ClientReady, c => {
  console.log(`Ready! Logged in as ${c.user.tag}`);
  new ReleaseChecker(c).run();
});
client.login(env.DISCORD_TOKEN);
