from typing import TypeVar, Generic
from abc import ABC, abstractmethod
from dataclasses import dataclass

T = TypeVar("T")


class Tool(ABC):
    def __init__(self):
        pass

    @abstractmethod
    def run(self, args: object):
        pass

    @abstractmethod
    def coverage(self, outdir: object):
        pass


@dataclass
class Config(Generic[T]):
    tool: Tool
    args: T

    def run(self):
        self.tool.run(self.args)

    def coverage(self):
        self.tool.coverage(self.args)
