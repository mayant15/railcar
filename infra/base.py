from abc import ABC, abstractmethod
from dataclasses import dataclass


class Tool(ABC):
    def __init__(self):
        pass

    @abstractmethod
    def run(self, args: object) -> str:
        pass


@dataclass
class Config:
    tool: Tool
    args: object

    def run(self):
        self.tool.run(self.args)
