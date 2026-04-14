from argparse import ArgumentParser
from pathlib import Path

import pymc as pm
import numpy as np
import pandas as pd
import arviz as az
import matplotlib.pyplot as plt

SCHEMA_ORDER = ["Random", "SynTest", "TypeScript"]  # Random = reference level

def build_varying_slopes(df: pd.DataFrame, coverage_col: str = "coverage"):
    df = df.copy()

    df["schema"]  = pd.Categorical(df["schema"],  categories=SCHEMA_ORDER)

    project_cat   = pd.Categorical(df["project"])
    libraries     = project_cat.categories.tolist()
    df["project"] = project_cat

    df["schema_idx"]  = df["schema"].cat.codes
    df["library_idx"] = df["project"].cat.codes

    n_libs    = df["library_idx"].nunique()
    # Design matrix for schema: drop Random (reference), keep SynTest + TypeScript
    # Shape: (N, 2)  — columns are [I(SynTest), I(TypeScript)]
    X_schema = pd.get_dummies(df["schema"], drop_first=True).values.astype(float)
    n_slopes = X_schema.shape[1]   # = 2

    library_idx = df["library_idx"].values
    coverage    = df[coverage_col].values

    with pm.Model() as model:
        # ── Hyperpriors (population-level) ───────────────────────────────
        # Global intercept and schema effects
        mu_alpha   = pm.Normal("mu_alpha",  mu=0, sigma=20)
        mu_betas   = pm.Normal("mu_betas",  mu=0, sigma=10, shape=n_slopes)

        # ── Covariance structure (LKJ prior) ─────────────────────────────
        # Models correlation between intercept and slopes across libraries.
        # eta=2 weakly regularises toward no correlation.
        sd_dist  = pm.HalfNormal.dist(sigma=10, shape=1 + n_slopes)
        chol, corr, stds = pm.LKJCholeskyCov(
            "chol", n=1 + n_slopes, eta=2, sd_dist=sd_dist, compute_corr=True
        )
        pm.Deterministic("corr", corr)   # log for inspection

        # ── Per-library random effects (non-centered parameterisation) ────
        # z: standardised offsets, shape (n_libs, 1 + n_slopes)
        z = pm.Normal("z", mu=0, sigma=1, shape=(n_libs, 1 + n_slopes))
        # offsets = z @ chol.T, shape (n_libs, 1 + n_slopes)
        offsets = pm.Deterministic("offsets", pm.math.dot(z, chol.T))

        alpha_lib = pm.Deterministic(
            "alpha_lib", mu_alpha + offsets[:, 0]
        )
        # beta_lib[j, k] = effect of schema k in library j
        beta_lib = pm.Deterministic(
            "beta_lib", mu_betas[None, :] + offsets[:, 1:]
        )

        # ── Likelihood ────────────────────────────────────────────────────
        sigma_obs = pm.HalfNormal("sigma_obs", sigma=10)
        mu = (
            alpha_lib[library_idx]
            + pm.math.sum(beta_lib[library_idx] * X_schema, axis=1)
        )
        pm.Normal("coverage", mu=mu, sigma=sigma_obs, observed=coverage)

        # ── Derived: per-library schema effects ───────────────────────────
        # Absolute effect of TypeScript over Random, per library
        pm.Deterministic("effect_TS_per_lib",  beta_lib[:, 1])  # TypeScript col
        pm.Deterministic("effect_SyT_per_lib", beta_lib[:, 0])  # SynTest col
        pm.Deterministic("effect_TS_vs_SyT",   beta_lib[:, 1] - beta_lib[:, 0])

        idata = pm.sample(
            draws=2000, tune=1500,
            target_accept=0.95,     # higher: varying slopes have more curvature
            return_inferencedata=True,
            idata_kwargs={"log_likelihood": True},
        )
        idata.attrs["libraries"] = libraries  # attach for plotting

    return model, idata


def plot_per_library_effects(idata: az.InferenceData, out_dir: Path):
    """
    Forest plot of per-library TypeScript effect with 94% HDI.
    Libraries sorted by posterior median — immediately shows winners/losers.
    """
    libraries = idata.attrs["libraries"]
    samples   = idata.posterior["effect_TS_per_lib"].values  # (chain, draw, lib)
    samples   = samples.reshape(-1, len(libraries))

    medians = np.median(samples, axis=0)
    lo      = np.percentile(samples, 3,  axis=0)
    hi      = np.percentile(samples, 97, axis=0)

    order     = np.argsort(medians)
    libraries = [libraries[i] for i in order]
    medians, lo, hi = medians[order], lo[order], hi[order]

    colors = ["#6abf8a" if m > 0 else "#e07b54" for m in medians]

    fig, ax = plt.subplots(figsize=(7, 0.45 * len(libraries) + 2))
    ax.barh(libraries, medians, xerr=[medians - lo, hi - medians],
            color=colors, alpha=0.8, edgecolor="white", capsize=3)
    ax.axvline(0, color="black", linewidth=1.4, linestyle="--")
    ax.set_xlabel("TypeScript − Random effect on coverage (pp)\nwith 94% HDI")
    ax.set_title("Per-library schema effect\n(green = TypeScript helps, red = hurts)")
    fig.tight_layout()
    fig.savefig(out_dir / "per_library_TS_effect.png", dpi=150)
    plt.close(fig)


def plot_correlation_matrix(idata: az.InferenceData, out_dir: Path):
    """
    Posterior of the correlation matrix between intercept and slopes.
    Key question: do libraries with high baseline also benefit more from schemas?
    """
    az.plot_posterior(idata, var_names=["corr"], figsize=(10, 4))
    plt.suptitle("Posterior correlations: (intercept, SynTest slope, TypeScript slope)")
    plt.tight_layout()
    plt.savefig(out_dir / "slope_correlations.png", dpi=150)
    plt.close()


def rank_libraries_by_effect(idata: az.InferenceData, threshold: float = 0.0):
    """
    For each library: P(TypeScript effect > threshold).
    Use this to prioritise case studies.
    """
    libraries = idata.attrs["libraries"]
    samples   = idata.posterior["effect_TS_per_lib"].values.reshape(-1, len(libraries))

    rows = []
    for lib, col in zip(libraries, samples.T):
        rows.append({
            "library":        lib,
            "median_effect":  np.median(col),
            "hdi_3%":         np.percentile(col, 3),
            "hdi_97%":        np.percentile(col, 97),
            f"P(effect>{threshold})": (col > threshold).mean(),
        })

    return (pd.DataFrame(rows)
              .sort_values("median_effect", ascending=False)
              .reset_index(drop=True))


def main():
    parser = ArgumentParser()
    parser.add_argument("csv")
    parser.add_argument("--outdir", default="figures")
    args = parser.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(args.csv)

    model, idata = build_varying_slopes(df)

    # Prior predictive check
    with model:
        prior_idata = pm.sample_prior_predictive(samples=500)
    az.plot_ppc(prior_idata, group="prior", observed=False)
    plt.title("Prior predictive — does this cover plausible coverage values?")
    plt.savefig("prior_predictive.png", dpi=150)

    rank_libraries_by_effect(idata)

    plot_per_library_effects(idata, outdir)
    plot_correlation_matrix(idata, outdir)


if __name__ == "__main__":
    main()