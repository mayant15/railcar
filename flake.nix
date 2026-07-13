{
  description = "Automatic JavaScript library fuzzing";
  inputs.nixpkgs.url = "flake:nixpkgs/nixos-26.05";
  outputs = { nixpkgs, ... }:
    let
      systems = ["x86_64-linux"];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forEachSystem ( system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              rustc
              cargo
              clippy
              rustfmt
              rust-analyzer
              nodejs_24
              bun
            ];
          };
        }
      );
    };
}
